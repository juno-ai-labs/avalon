import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  bindLoopNonSystemMessages,
  type BindLoopTransition,
} from "@rally/agent-harness";
import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { WorkstreamHarnessRunStorage } from "../src/durable-objects/workstream-harness-run-storage";
import { dueSemanticRealtimeReferences } from "../src/durable-objects/workstream-semantic-realtime-outbox";
import {
  prepareTranscriptFact,
  type PendingInputDeliveryEffectInput,
  WorkstreamTranscriptStorage,
} from "../src/durable-objects/workstream-transcript-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const NOW = 1_787_000_000_000;
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function open(options: { getCurrentBookmark?: () => Promise<string> } = {}): {
  transcript: WorkstreamTranscriptStorage;
  sql: SqlStorage;
  database: DatabaseSync;
  storage: DurableObjectStorage;
} {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = createTestSqlStorage(database);
  const binding = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    getCurrentBookmark: options.getCurrentBookmark ?? (async () => "bookmark-before-backfill"),
    setAlarm: async () => undefined,
    transactionSync: <T,>(body: () => T): T => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = body();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    sql,
  });
  applyWorkstreamObjectSchema(binding, "test", 1);
  return { transcript: new WorkstreamTranscriptStorage(binding), sql, database, storage: binding };
}

const systemProjection = {
  revision: 1,
  rendererVersion: "workstream-system-v1",
  inputHash: "input-1",
  message: { role: "system", content: "System" },
};

async function relocatedReservation(toolCount = 0, outcome: "accepted" | "failed" | "stopped" = "accepted") {
  const fixture = open();
  seedPendingInputRoot(fixture.sql);
  await fixture.transcript.commitBindTransition(initialize(), NOW);
  const reserved = await reserveAssistantFixture({ ...fixture, content: "Historical answer", toolCount, now: NOW + 1 });
  if (outcome === "accepted") {
    await fixture.transcript.commitBindTransition(reserved.transition, NOW + 2, reserved.executionFence);
  } else {
    await fixture.transcript.settleActiveAssistantReservation({
      loopId: "run-1", ...reserved.executionFence, outcome,
      code: outcome === "stopped" ? "run_cancelled" : "assistant_turn_interrupted",
      label: "Historical interruption", now: NOW + 2,
    });
  }
  // Reproduce the operator's copy: relational loop keys move; historical
  // turn IDs and the content-addressed transcript remain unchanged.
  fixture.storage.transactionSync(() => {
    fixture.sql.exec(`PRAGMA defer_foreign_keys = ON`);
    for (const table of ["substream_loops", "bind_loop_heads", "bind_loop_state_messages",
      "bind_provider_boundaries", "bind_activation_inputs", "assistant_turn_reservations"]) {
      fixture.sql.exec(`UPDATE ${table} SET loop_id = 'relocated-loop' WHERE loop_id = 'run-1'`);
    }
    fixture.sql.exec(`UPDATE runs SET substream_loop_id = 'relocated-loop' WHERE substream_loop_id = 'run-1'`);
  });
  const transcript = new WorkstreamTranscriptStorage(fixture.storage);
  return { ...fixture, transcript, projection: transcript.readBindProjection("relocated-loop")! };
}

describe("historical assistant reservation validation", () => {
  it("preserves the historical transcript and advances to the next turn under the relocated loop", async () => {
    const { transcript, projection, sql, storage } = await relocatedReservation();
    expect(transcript.validateHistoricalAssistantReservation(projection)).toBe(true);
    expect(transcript.readBindProjection("relocated-loop")!.lastAssistantReservation!.turnId)
      .toBe("run-1:turn:1");
    expect(transcript.participantTurn("run-1:turn:1")!.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Historical answer" }),
    ]));
    const loop = new SubstreamLoopStorage(storage);
    const active = loop.loop()!;
    const reserved = loop.reserveAssistantTurn({
      executionId: active.active_execution_id!, executionEpoch: active.active_execution_epoch!,
      leaseOwner: active.lease_owner!, expectedLoopRevision: active.revision,
      receiptRunId: active.active_execution_id!, turnId: "relocated-loop:turn:2",
      modelTurnIndex: 2, streamId: "next-stream", now: NOW + 3,
    });
    expect(reserved.outcome).toBe("reserved");
    await transcript.commitBindTransition({
      kind: "assistant_reserved", loopId: "relocated-loop", generation: 1,
      stateRevision: projection.stateRevision + 1, turnId: "relocated-loop:turn:2",
      modelTurnIndex: 2, transcriptSequence: reserved.reservation.transcript_sequence,
    }, NOW + 3);
    expect(transcript.readBindProjection("relocated-loop")!.lastAssistantReservation).toMatchObject({
      turnId: "relocated-loop:turn:2", modelTurnIndex: 2, status: "pending",
    });
    expect(sql.exec(`SELECT turn_id FROM participant_transcript_turns WHERE actor = 'assistant'`).toArray())
      .toEqual([{ turn_id: "run-1:turn:1" }]);
  });

  it("rejects an accepted assistant with unfinished tool calls", async () => {
    const { transcript, projection } = await relocatedReservation(1);
    expect(transcript.validateHistoricalAssistantReservation(projection)).toBe(false);
  });

  it.each(["failed", "stopped"] as const)("resumes a materialized historical %s turn", async (outcome) => {
    const { transcript, projection, sql } = await relocatedReservation(0, outcome);
    expect(projection.lastAssistantReservation!.status).toBe(outcome);
    expect(transcript.validateHistoricalAssistantReservation(projection)).toBe(true);
    expect(transcript.participantTurn("run-1:turn:1")!.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Historical interruption" }),
    ]));
    sql.exec(`UPDATE assistant_turn_reservations SET outcome = 'accepted'`);
    expect(transcript.validateHistoricalAssistantReservation(projection)).toBe(false);
  });

  it("uses ordinary reservation settlement after a crash before the next Bind transition", async () => {
    const { transcript, projection, storage, sql } = await relocatedReservation();
    const loop = new SubstreamLoopStorage(storage);
    const active = loop.loop()!;
    loop.reserveAssistantTurn({
      executionId: active.active_execution_id!, executionEpoch: active.active_execution_epoch!,
      leaseOwner: active.lease_owner!, expectedLoopRevision: active.revision,
      receiptRunId: active.active_execution_id!, turnId: "relocated-loop:turn:2",
      modelTurnIndex: 2, streamId: "interrupted-stream", now: NOW + 3,
    });
    expect(transcript.validateHistoricalAssistantReservation(projection)).toBe(false);
    sql.exec(`UPDATE substream_loops SET active_execution_epoch = active_execution_epoch + 1`);
    const replacement = loop.loop()!;
    await transcript.settleActiveAssistantReservation({
      loopId: "relocated-loop", executionId: replacement.active_execution_id!,
      executionEpoch: replacement.active_execution_epoch!, leaseOwner: replacement.lease_owner!,
      outcome: "failed", code: "assistant_turn_interrupted", label: "Interrupted", now: NOW + 4,
    });
    expect(transcript.readBindProjection("relocated-loop")!.lastAssistantReservation)
      .toMatchObject({ turnId: "relocated-loop:turn:2", modelTurnIndex: 2, status: "failed" });
    expect(loop.loop()!.next_assistant_turn_sequence).toBe(3);
    expect(transcript.participantTurn("run-1:turn:1")).not.toBeNull();
  });

  it.each([
    ["wrong next counter", `UPDATE substream_loops SET next_assistant_turn_sequence = 7`],
    ["wrong loop revision", `UPDATE substream_loops SET bind_state_revision = 999`],
    ["missing reservation", `DELETE FROM assistant_turn_reservations`],
    ["wrong transcript actor", `UPDATE participant_transcript_turns SET actor = 'system'`],
    ["wrong reservation outcome", `UPDATE assistant_turn_reservations SET outcome = 'error'`],
    ["pending reservation", `UPDATE assistant_turn_reservations SET state = 'reserved', outcome = NULL,
      started_at = NULL, materialized_at = NULL, materialized_turn_id = NULL`],
    ["wrong transcript sequence", `UPDATE assistant_turn_reservations SET transcript_sequence = 99`],
    ["wrong model turn index", `UPDATE assistant_turn_reservations SET assistant_turn_sequence = 99`],
  ])("rejects %s", async (_name, mutation) => {
    const { transcript, projection, sql } = await relocatedReservation();
    sql.exec(mutation);
    expect(transcript.validateHistoricalAssistantReservation(projection)).toBe(false);
  });

  it("rejects a stale head and a fabricated historical turn", async () => {
    const { transcript, projection } = await relocatedReservation();
    expect(transcript.validateHistoricalAssistantReservation({ ...projection, stateRevision: 1 })).toBe(false);
    expect(transcript.validateHistoricalAssistantReservation({
      ...projection, lastAssistantReservation: { ...projection.lastAssistantReservation!, turnId: "foreign:turn:1" },
    })).toBe(false);
  });

  it("rejects a collision with the next transcript turn", async () => {
    const { transcript, projection } = await relocatedReservation();
    await transcript.appendParticipantMessage({
      turnId: "relocated-loop:turn:2", actor: "human", authorUserId: "user-1",
      authorSnapshot: { displayName: "Test", avatarUrl: null }, text: "Collision",
      createdAtUtc: new Date(NOW + 3).toISOString(), attentionOrdinal: 1,
    });
    expect(transcript.validateHistoricalAssistantReservation(projection)).toBe(false);
  });
});

function initialize(): BindLoopTransition {
  return {
    kind: "state_initialized",
    loopId: "run-1",
    generation: 1,
    stateRevision: 1,
    systemProjection,
    nonSystemMessages: [{ role: "user", content: "Question" }],
    nonSystemMessageOrigins: [{
      originKind: "derived",
      sourceKind: "participant_turn",
      sourceId: "message-1",
      sourceRevision: 1,
    }],
  };
}

function initializePersistentLoop(): Extract<BindLoopTransition, { kind: "state_initialized" }> {
  return {
    kind: "state_initialized",
    loopId: "persistent-loop",
    generation: 1,
    stateRevision: 1,
    systemProjection,
    nonSystemMessages: [],
    nonSystemMessageOrigins: [],
  };
}

function assistant(revision: number, turn: number, content: string, toolCount = 0): BindLoopTransition {
  return {
    kind: "assistant_accepted",
    loopId: "run-1",
    generation: 1,
    stateRevision: revision,
    turnId: `run-1:turn:${turn}`,
    modelTurnIndex: turn,
    transcriptSequence: turn,
    message: {
      role: "assistant",
      content,
      ...(toolCount > 0 ? {
        tool_calls: Array.from({ length: toolCount }, (_, index) => ({
          id: `provider-${turn}-${index}`,
          type: "function",
          function: { name: `tool-${index}`, arguments: "{}" },
        })),
      } : {}),
    },
  };
}

async function reserveAssistantFixture(input: {
  transcript: WorkstreamTranscriptStorage;
  storage: DurableObjectStorage;
  content: string;
  toolCount?: number;
  now: number;
}): Promise<{
  transition: Extract<BindLoopTransition, { kind: "assistant_accepted" }>;
  executionFence: {
    executionId: string;
    executionEpoch: number;
    leaseOwner: string;
    expectedBindStateRevision: number;
  };
}> {
  const executionId = "00000000-0000-7000-8000-0000000000f1";
  const leaseOwner = "transcript-fixture-owner";
  const projection = input.transcript.readBindProjection("run-1");
  if (!projection) throw new Error("test_bind_projection_missing");
  input.storage.sql.exec(
    `INSERT OR IGNORE INTO substreams
       (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
     VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', ?)`,
    input.now,
  );
  const runs = new WorkstreamHarnessRunStorage(input.storage);
  const admitted = runs.admitRun({
    runId: executionId,
    origin: "member_message",
    executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
    status: "running",
    startedAt: input.now,
    model: "test/model",
    triggerPartId: null,
    parentRunId: null,
    expectedLatestRunId: null,
    now: input.now,
  });
  if (admitted.outcome !== "admitted") throw new Error("test_execution_receipt_not_admitted");
  input.storage.sql.exec(
    `UPDATE runs SET execution_context_json = '{"kind":"test_execution"}' WHERE run_id = ?`,
    executionId,
  );
  const loop = new SubstreamLoopStorage(input.storage);
  loop.ensureLoop({
    loopId: "run-1",
    bindStateRevision: projection.stateRevision,
    now: input.now,
  });
  loop.activateExecutionReceipt({
    runId: executionId,
    loopId: "run-1",
    executionEpoch: 1,
    leaseOwner,
    leaseExpiresAt: input.now + 60_000,
    expectedLoopRevision: loop.loop()!.revision,
    expectedBindStateRevision: projection.stateRevision,
    now: input.now,
  });
  const reservation = loop.reserveAssistantTurn({
    executionId,
    executionEpoch: 1,
    leaseOwner,
    expectedLoopRevision: loop.loop()!.revision,
    receiptRunId: executionId,
    turnId: "run-1:turn:1",
    modelTurnIndex: 1,
    streamId: "transcript-fixture-stream",
    now: input.now,
  });
  if (reservation.outcome !== "reserved") throw new Error("test_assistant_turn_not_reserved");
  await input.transcript.commitBindTransition({
    kind: "assistant_reserved",
    loopId: "run-1",
    generation: projection.generation,
    stateRevision: projection.stateRevision + 1,
    turnId: "run-1:turn:1",
    modelTurnIndex: 1,
    transcriptSequence: reservation.reservation.transcript_sequence,
  }, input.now, {
    executionId,
    executionEpoch: 1,
    leaseOwner,
    expectedBindStateRevision: projection.stateRevision,
  });
  const transition = assistant(
    projection.stateRevision + 2,
    1,
    input.content,
    input.toolCount,
  ) as Extract<BindLoopTransition, { kind: "assistant_accepted" }>;
  transition.transcriptSequence = reservation.reservation.transcript_sequence;
  return {
    transition,
    executionFence: {
      executionId,
      executionEpoch: 1,
      leaseOwner,
      expectedBindStateRevision: projection.stateRevision + 1,
    },
  };
}

function seedPendingInputRoot(sql: SqlStorage): void {
  sql.exec(`INSERT INTO workstream (
    id, workstream_key, parent_workspace_key, region, authority_mode, authority_generation,
    title, description, scope, exact_state, state_reason_code, next_sequence_number,
    next_attention_ordinal, authority_epoch, scope_epoch, source_authorization_floor,
    listing_epoch, deletion_epoch, run_revision, created_at, last_people_activity_at,
    state_changed_at, updated_at
  ) VALUES (1, 'workstream', 'workspace', 'global', 'authoritative', 1, '', '',
    'workspace', 'running', 'test', 1, 1, 1, 0, 0, 1, 0, 1, ?, ?, ?, ?)`,
  NOW, NOW, NOW, NOW);
  sql.exec(
    `INSERT INTO substreams
       (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
     VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', ?)`,
    NOW,
  );
}

async function admitPendingInput(input: {
  storage: DurableObjectStorage;
  attachmentResourceJson?: string;
  inputId?: string;
  clientMessageId?: string;
  text?: string;
  bindContent?: unknown;
  withAttachment?: boolean;
  messageType?: "text" | "elicitation" | "automation_activation";
  elicitationId?: string;
  /** `system` is what an automation's posted result is admitted as: no author, a `system` canonical role. */
  actor?: "human" | "system";
  /** `false` admits a message to the room that queues only to keep send order. */
  startsRun?: boolean;
  /** The Slack message the input came from, as admission records it. */
  slackOrigin?: unknown;
}): Promise<{ inputId: string; attachmentId: string; loop: SubstreamLoopStorage }> {
  const inputId = input.inputId ?? "00000000-0000-7000-8000-000000000101";
  const attachmentId = "00000000-0000-7000-8000-000000000102";
  const actor = input.actor ?? "human";
  const text = input.text ?? "Hello @Ada";
  const mentionStart = text.indexOf("@Ada");
  if (mentionStart < 0 && actor === "human") throw new Error("pending_input_test_mention_missing");
  const loop = new SubstreamLoopStorage(input.storage);
  loop.ensureLoop({ loopId: "persistent-loop", bindStateRevision: 0, now: NOW });
  const clientMessageId = input.clientMessageId ?? "client-pending-1";
  loop.reserveInputPreparation({
    inputId,
    loopId: "persistent-loop",
    clientMessageId,
    preparationKind: actor === "system" ? "automation_activation" : "human_message",
    envelopeJson: JSON.stringify({ input: { text } }),
    now: NOW,
  });
  const fact = await prepareTranscriptFact({
    factId: `${inputId}:message`,
    factKind: "participant_message",
    audience: "shared",
    payload: { role: actor === "system" ? "system" : "user", content: text, structuredContent: { source: "test" } },
    origin: { originKind: "canonical", sourceKind: null, sourceId: null, sourceRevision: null },
    runId: null,
    turnId: inputId,
    toolCallId: null,
  });
  const resourceJson = input.attachmentResourceJson ?? JSON.stringify({
    id: attachmentId,
    title: "evidence.pdf",
    mimeType: "application/pdf",
    contentRef: "resource-content",
    metadata: { size: 42 },
  });
  const admittedAuthor = input.storage.sql.exec<{ participant_epoch: number }>(
    `SELECT participant_epoch FROM participants WHERE user_id = 'user-1'`,
  ).toArray()[0];
  loop.completeInputPreparation({
    inputId,
    preparedTurnId: inputId,
    mode: actor === "system" || input.startsRun === false ? "queue" : "steer",
    ...(input.startsRun === false ? { startsRun: false } : {}),
    actor,
    authorUserId: actor === "system" ? null : "user-1",
    authorNameSnapshot: actor === "system" ? null : "Ada at admission",
    authorAvatarUrlSnapshot: null,
    clientMessageId,
    externalActorJson: null,
    messageType: input.messageType ?? "text",
    preparedPayloadId: fact.payloadId,
    preparedFactId: fact.factId,
    preparedPayloadAudience: fact.audience,
    preparedPayloadMediaType: "application/json",
    preparedPayloadJson: fact.canonical,
    bindPayloadJson: JSON.stringify({ content: input.bindContent ?? text, role: "user" }),
    preparedPayloadSha256: fact.hash,
    preparedPayloadByteLength: new TextEncoder().encode(fact.canonical).byteLength,
    provenanceJson: JSON.stringify({
      factKind: fact.factKind,
      originKind: fact.origin.originKind,
      sourceKind: fact.origin.sourceKind,
      sourceId: fact.origin.sourceId,
      sourceRevision: fact.origin.sourceRevision,
      runId: fact.runId,
      toolCallId: fact.toolCallId,
    }),
    authorizationJson: JSON.stringify({
      executionPrincipal: { type: "user", userId: "user-1" },
      confirmedParticipantUserIds: [],
      participantEpochs: { "user-1": admittedAuthor?.participant_epoch ?? null },
      workspaceMembershipRevision: 7,
      ...(input.elicitationId ? { elicitationId: input.elicitationId } : {}),
      ...(input.slackOrigin ? { slackOrigin: input.slackOrigin } : {}),
    }),
    attachmentsJson: JSON.stringify(input.withAttachment === false ? [] : [{
      resourceId: attachmentId,
      position: 0,
      attachmentJson: JSON.stringify({ attachedAt: new Date(NOW + 1).toISOString() }),
      attachedByUserId: "user-1",
      watchEnabled: false,
      relationshipType: "message_attachment",
      resourceJson,
      attachedAt: NOW + 1,
      updatedAt: NOW + 1,
    }]),
    mentionsJson: JSON.stringify(mentionStart < 0 ? [] : [{
      mentionIndex: 0,
      mentionKind: "person",
      targetUserId: "user-2",
      connectorType: null,
      startOffset: mentionStart,
      endOffset: mentionStart + "@Ada".length,
    }]),
    now: NOW + 1,
  });
  if (input.withAttachment !== false) {
    input.storage.sql.exec(
      `INSERT INTO pending_attachment_reservation_recovery
       (input_id, resource_id, workspace_id, workstream_id,
          release_authority, created_at)
       VALUES (?, ?,
               '00000000-0000-7000-8000-000000000201',
               '00000000-0000-7000-8000-000000000202',
               'preparation', ?)`,
      inputId,
      attachmentId,
      NOW + 1,
    );
  }
  return { inputId, attachmentId, loop };
}

async function completeMailboxInput(input: {
  loop: SubstreamLoopStorage;
  inputId: string;
  clientMessageId: string;
  now: number;
}): Promise<void> {
  const fact = await prepareTranscriptFact({
    factId: `${input.inputId}:message`,
    factKind: "participant_message",
    audience: "shared",
    payload: { role: "user", content: input.clientMessageId },
    origin: { originKind: "canonical", sourceKind: null, sourceId: null, sourceRevision: null },
    runId: null,
    turnId: input.inputId,
    toolCallId: null,
  });
  input.loop.completeInputPreparation({
    inputId: input.inputId,
    preparedTurnId: input.inputId,
    mode: "steer",
    actor: "external",
    authorUserId: null,
    authorNameSnapshot: null,
    authorAvatarUrlSnapshot: null,
    clientMessageId: input.clientMessageId,
    externalActorJson: JSON.stringify({ type: "slack", id: "external-user" }),
    messageType: "text",
    preparedPayloadId: fact.payloadId,
    preparedFactId: fact.factId,
    preparedPayloadAudience: fact.audience,
    preparedPayloadMediaType: "application/json",
    preparedPayloadJson: fact.canonical,
    preparedPayloadSha256: fact.hash,
    preparedPayloadByteLength: new TextEncoder().encode(fact.canonical).byteLength,
    bindPayloadJson: JSON.stringify({ content: input.clientMessageId, role: "user" }),
    provenanceJson: JSON.stringify({
      factKind: fact.factKind,
      originKind: fact.origin.originKind,
      sourceKind: fact.origin.sourceKind,
      sourceId: fact.origin.sourceId,
      sourceRevision: fact.origin.sourceRevision,
      runId: fact.runId,
      toolCallId: fact.toolCallId,
    }),
    authorizationJson: JSON.stringify({ executionPrincipal: { type: "system" } }),
    attachmentsJson: "[]",
    mentionsJson: "[]",
    now: input.now,
  });
}

describe("canonical ordered work-stream transcript", () => {
  it("canonicalizes immutable fact keys by UTF-16 code unit", async () => {
    const fact = await prepareTranscriptFact({
      factId: "fact-code-unit-order",
      factKind: "test",
      audience: "participant",
      payload: { "é": 3, a: 2, "😀": 4, Z: 1 },
      origin: {
        originKind: "protocol",
        sourceKind: null,
        sourceId: null,
        sourceRevision: null,
      },
      runId: null,
      turnId: null,
      toolCallId: null,
    });
    expect(fact.canonical).toBe('{"Z":1,"a":2,"é":3,"😀":4}');
  });

  it("serves an oversized turn as a sequence-owning envelope with payloads omitted", async () => {
    const { transcript, sql } = open();
    await transcript.appendParticipantMessage({
      turnId: "oversized-turn",
      actor: "human",
      authorUserId: "user-1",
      authorSnapshot: { displayName: "Ada", avatarUrl: null },
      text: "Payload remains canonical",
      createdAtUtc: new Date(NOW).toISOString(),
      attentionOrdinal: 1,
    });
    const turn = transcript.participantTurn("oversized-turn")!;
    const envelope = transcript.omittedTurnEnvelope(turn);
    expect(envelope).toMatchObject({
      turnId: "oversized-turn",
      transcriptSequence: turn.transcriptSequence,
      revision: 1,
      blocks: [],
      blockCount: 1,
      blocksOmitted: true,
    });
    // The envelope is a projection, never a second store: producing it writes
    // nothing, so the append's one content-addressed payload stays the total.
    expect(sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM transcript_payloads`,
    ).one().count).toBe(1);
  });

  it("reserves order before preparation and never lets a later ready input pass it", async () => {
    const { sql, storage } = open();
    seedPendingInputRoot(sql);
    const loop = new SubstreamLoopStorage(storage);
    loop.ensureLoop({ loopId: "persistent-loop", bindStateRevision: 0, now: NOW });
    const firstInputId = "00000000-0000-7000-8000-000000000201";
    const secondInputId = "00000000-0000-7000-8000-000000000202";
    const first = loop.reserveInputPreparation({
      inputId: firstInputId,
      loopId: "persistent-loop",
      clientMessageId: "mailbox-first",
      preparationKind: "external_message",
      envelopeJson: JSON.stringify({ input: { text: "first" } }),
      now: NOW + 1,
    });
    expect(() => loop.reserveInputPreparation({
      inputId: "00000000-0000-7000-8000-000000000203",
      loopId: "persistent-loop",
      clientMessageId: "mailbox-first",
      preparationKind: "external_message",
      envelopeJson: JSON.stringify({ input: { text: "changed replay" } }),
      now: NOW + 2,
    })).toThrow("pending_input_preparation_replay_mismatch");
    expect(loop.reserveInputPreparation({
      inputId: "00000000-0000-7000-8000-000000000204",
      loopId: "persistent-loop",
      clientMessageId: "mailbox-first",
      preparationKind: "external_message",
      envelopeJson: JSON.stringify({ input: { text: "first" } }),
      now: NOW + 2,
    })).toMatchObject({ outcome: "reused", preparation: { input_id: firstInputId } });
    const second = loop.reserveInputPreparation({
      inputId: secondInputId,
      loopId: "persistent-loop",
      clientMessageId: "mailbox-second",
      preparationKind: "external_message",
      envelopeJson: JSON.stringify({ input: { text: "second" } }),
      now: NOW + 2,
    });
    expect([first.preparation.input_sequence, second.preparation.input_sequence]).toEqual([1, 2]);
    expect([
      first.preparation.admitted_after_transcript_sequence,
      second.preparation.admitted_after_transcript_sequence,
    ]).toEqual([0, 0]);

    await completeMailboxInput({
      loop,
      inputId: secondInputId,
      clientMessageId: "mailbox-second",
      now: NOW + 3,
    });
    expect(loop.pendingInputs()).toEqual([]);
    expect(dueSemanticRealtimeReferences(sql, NOW + 3)).toEqual([]);

    // Canonical work may advance while the earlier input is still preparing.
    // Both pending positions remain anchored where ingress reserved their FIFO
    // order rather than where their asynchronous preparation happened to end.
    sql.exec(`UPDATE transcript_counters SET next_transcript_sequence = 2 WHERE id = 1`);

    await completeMailboxInput({
      loop,
      inputId: firstInputId,
      clientMessageId: "mailbox-first",
      now: NOW + 4,
    });
    expect(loop.pendingInputs().map((pending) => ({
      inputId: pending.input_id,
      inputSequence: pending.input_sequence,
    }))).toEqual([
      { inputId: firstInputId, inputSequence: 1 },
      { inputId: secondInputId, inputSequence: 2 },
    ]);
    expect(loop.pendingInputs().map((pending) => pending.admitted_after_transcript_sequence))
      .toEqual([0, 0]);
    expect(dueSemanticRealtimeReferences(sql, NOW + 4).map((pending) => pending.reference))
      .toEqual([
        { kind: "loop_input_upserted", inputId: firstInputId },
        { kind: "loop_input_upserted", inputId: secondInputId },
      ]);
  });

  it("lets pending input_sequence change while prepared content stays immutable", async () => {
    const { sql, storage } = open();
    seedPendingInputRoot(sql);
    const { inputId } = await admitPendingInput({ storage, withAttachment: false });
    sql.exec(
      `UPDATE pending_loop_inputs SET input_sequence = 4, updated_at = ? WHERE input_id = ?`,
      NOW + 9,
      inputId,
    );
    expect(sql.exec(
      `SELECT input_sequence, mode FROM pending_loop_inputs WHERE input_id = ?`,
      inputId,
    ).one()).toEqual({ input_sequence: 4, mode: "steer" });
    expect(() => sql.exec(
      `UPDATE pending_loop_inputs SET mode = 'queue' WHERE input_id = ?`,
      inputId,
    )).toThrow(/pending_loop_input_prepared_fields_are_immutable/u);
  });

  it("reorders visible pending inputs without consuming next_input_sequence or bumping revision", async () => {
    const { sql, storage } = open();
    seedPendingInputRoot(sql);
    const firstId = "00000000-0000-7000-8000-000000000111";
    const secondId = "00000000-0000-7000-8000-000000000112";
    const thirdId = "00000000-0000-7000-8000-000000000113";
    const first = await admitPendingInput({
      storage,
      withAttachment: false,
      inputId: firstId,
      clientMessageId: "client-reorder-1",
      text: "First @Ada",
    });
    await admitPendingInput({
      storage,
      withAttachment: false,
      inputId: secondId,
      clientMessageId: "client-reorder-2",
      text: "Second @Ada",
    });
    await admitPendingInput({
      storage,
      withAttachment: false,
      inputId: thirdId,
      clientMessageId: "client-reorder-3",
      text: "Third @Ada",
    });
    const loop = first.loop;
    const before = loop.loop()!;
    expect(loop.pendingInputs().map((pending) => pending.input_id))
      .toEqual([firstId, secondId, thirdId]);
    const beforeRefs = dueSemanticRealtimeReferences(sql, NOW + 20).length;

    expect(storage.transactionSync(() => loop.reorderPendingInputsInTransaction({
      inputIds: [thirdId, firstId, secondId],
      now: NOW + 21,
    })).map((pending) => ({
      inputId: pending.input_id,
      inputSequence: Number(pending.input_sequence),
    }))).toEqual([
      { inputId: thirdId, inputSequence: 1 },
      { inputId: firstId, inputSequence: 2 },
      { inputId: secondId, inputSequence: 3 },
    ]);
    const after = loop.loop()!;
    expect(after.revision).toBe(before.revision);
    expect(after.next_input_sequence).toBe(before.next_input_sequence);
    const afterRefs = dueSemanticRealtimeReferences(sql, NOW + 21);
    expect(afterRefs.length).toBe(beforeRefs + 3);
    expect(afterRefs.slice(-3).map((pending) => pending.reference)).toEqual([
      { kind: "loop_input_upserted", inputId: thirdId },
      { kind: "loop_input_upserted", inputId: firstId },
      { kind: "loop_input_upserted", inputId: secondId },
    ]);

    expect(storage.transactionSync(() => loop.reorderPendingInputsInTransaction({
      inputIds: [thirdId, firstId, secondId],
      now: NOW + 22,
    })).map((pending) => pending.input_id)).toEqual([thirdId, firstId, secondId]);
    expect(dueSemanticRealtimeReferences(sql, NOW + 22).length).toBe(afterRefs.length);
    expect(loop.loop()!.revision).toBe(before.revision);
  });

  it("keeps unnamed visible pending inputs behind the named ones and leaves hidden rows alone", async () => {
    const { sql, storage } = open();
    seedPendingInputRoot(sql);
    const firstId = "00000000-0000-7000-8000-000000000121";
    const secondId = "00000000-0000-7000-8000-000000000122";
    const thirdId = "00000000-0000-7000-8000-000000000123";
    const hiddenId = "00000000-0000-7000-8000-000000000124";
    const first = await admitPendingInput({
      storage,
      withAttachment: false,
      inputId: firstId,
      clientMessageId: "client-unnamed-1",
      text: "Alpha @Ada",
    });
    await admitPendingInput({
      storage,
      withAttachment: false,
      inputId: secondId,
      clientMessageId: "client-unnamed-2",
      text: "Bravo @Ada",
    });
    await admitPendingInput({
      storage,
      withAttachment: false,
      inputId: thirdId,
      clientMessageId: "client-unnamed-3",
      text: "Charlie @Ada",
    });
    const loop = first.loop;
    expect(storage.transactionSync(() => loop.reorderPendingInputsInTransaction({
      inputIds: [thirdId],
      now: NOW + 30,
    })).map((pending) => pending.input_id)).toEqual([thirdId, firstId, secondId]);

    loop.reserveInputPreparation({
      inputId: hiddenId,
      loopId: "persistent-loop",
      clientMessageId: "client-hidden-preparing",
      preparationKind: "external_message",
      envelopeJson: JSON.stringify({ input: { text: "hidden" } }),
      now: NOW + 31,
    });
    const laterId = "00000000-0000-7000-8000-000000000125";
    loop.reserveInputPreparation({
      inputId: laterId,
      loopId: "persistent-loop",
      clientMessageId: "client-hidden-later",
      preparationKind: "external_message",
      envelopeJson: JSON.stringify({ input: { text: "later" } }),
      now: NOW + 32,
    });
    await completeMailboxInput({
      loop,
      inputId: laterId,
      clientMessageId: "client-hidden-later",
      now: NOW + 33,
    });
    expect(loop.pendingInputs().map((pending) => pending.input_id))
      .toEqual([thirdId, firstId, secondId]);
    const hiddenSequence = Number(sql.exec<{ input_sequence: number }>(
      `SELECT input_sequence FROM pending_loop_inputs WHERE input_id = ?`,
      laterId,
    ).one().input_sequence);
    const preparingSequence = Number(sql.exec<{ input_sequence: number }>(
      `SELECT input_sequence FROM pending_loop_input_mailbox WHERE input_id = ?`,
      hiddenId,
    ).one().input_sequence);

    expect(storage.transactionSync(() => loop.reorderPendingInputsInTransaction({
      inputIds: [secondId, thirdId, firstId],
      now: NOW + 34,
    })).map((pending) => pending.input_id)).toEqual([secondId, thirdId, firstId]);
    expect(Number(sql.exec<{ input_sequence: number }>(
      `SELECT input_sequence FROM pending_loop_inputs WHERE input_id = ?`,
      laterId,
    ).one().input_sequence)).toBe(hiddenSequence);
    expect(Number(sql.exec<{ input_sequence: number }>(
      `SELECT input_sequence FROM pending_loop_input_mailbox WHERE input_id = ?`,
      hiddenId,
    ).one().input_sequence)).toBe(preparingSequence);
  });

  it("terminalizes failed preparation explicitly and unblocks later ready input", async () => {
    const { sql, storage } = open();
    seedPendingInputRoot(sql);
    const loop = new SubstreamLoopStorage(storage);
    loop.ensureLoop({ loopId: "persistent-loop", bindStateRevision: 0, now: NOW });
    const firstInputId = "00000000-0000-7000-8000-000000000211";
    const secondInputId = "00000000-0000-7000-8000-000000000212";
    loop.reserveInputPreparation({
      inputId: firstInputId,
      loopId: "persistent-loop",
      clientMessageId: "mailbox-failed",
      preparationKind: "external_message",
      envelopeJson: JSON.stringify({ input: { text: "fails" } }),
      now: NOW + 1,
    });
    loop.reserveInputPreparation({
      inputId: secondInputId,
      loopId: "persistent-loop",
      clientMessageId: "mailbox-after-failure",
      preparationKind: "external_message",
      envelopeJson: JSON.stringify({ input: { text: "ready" } }),
      now: NOW + 2,
    });
    await completeMailboxInput({
      loop,
      inputId: secondInputId,
      clientMessageId: "mailbox-after-failure",
      now: NOW + 3,
    });
    expect(loop.pendingInputs()).toEqual([]);
    expect(dueSemanticRealtimeReferences(sql, NOW + 3)).toEqual([]);

    loop.failInputPreparation({
      inputId: firstInputId,
      terminalCode: "attachment_projection_failed",
      now: NOW + 4,
    });
    expect(loop.inputPreparation(firstInputId)).toMatchObject({
      state: "failed",
      envelope_json: null,
      terminal_code: "attachment_projection_failed",
    });
    expect(loop.pendingInputs().map((pending) => pending.input_id)).toEqual([secondInputId]);
    expect(dueSemanticRealtimeReferences(sql, NOW + 4).map((pending) => pending.reference))
      .toEqual([{ kind: "loop_input_upserted", inputId: secondInputId }]);

    const replay = loop.reserveInputPreparation({
      inputId: "00000000-0000-7000-8000-000000000213",
      loopId: "persistent-loop",
      clientMessageId: "mailbox-failed",
      preparationKind: "external_message",
      envelopeJson: JSON.stringify({ input: { text: "different" } }),
      now: NOW + 5,
    });
    expect(replay).toMatchObject({
      outcome: "reused",
      preparation: { input_id: firstInputId, state: "failed", input_sequence: 1 },
    });
  });

  it("keeps admitted input as an ordered overlay until one atomic canonical delivery", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    const { inputId, attachmentId, loop } = await admitPendingInput({ storage });

    const before = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 2,
    });
    expect(before.snapshotThrough).toBe(0);
    expect(before.ranges).toEqual([]);
    expect(before.pendingInputs).toEqual([expect.objectContaining({
      inputId,
      futureTurnId: inputId,
      inputSequence: 1,
      deliveryMode: "steer",
      afterTranscriptSequence: 0,
      authorSnapshot: {
        userId: "user-1",
        displayName: "Ada at admission",
        avatarUrl: null,
      },
      block: expect.objectContaining({
        text: "Hello @Ada",
        structuredContent: { source: "test" },
        mentions: [expect.objectContaining({ userId: "user-2", startOffset: 6, endOffset: 10 })],
        attachments: [expect.objectContaining({
          id: attachmentId,
          fileName: "evidence.pdf",
          sizeBytes: 42,
          contentAvailable: true,
        })],
      }),
    })]);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns`).one())
      .toEqual({ count: 0 });
    expect(sql.exec(`SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`).one())
      .toEqual({ next_transcript_sequence: 1 });
    expect(sql.exec(`SELECT next_attention_ordinal FROM workstream WHERE id = 1`).one())
      .toEqual({ next_attention_ordinal: 1 });

    const deliveryEffects: Array<{ inputId: string; activatedUserIds: string[] }> = [];
    const activation: Parameters<WorkstreamTranscriptStorage["activatePendingInput"]>[0] = {
      loopId: "persistent-loop",
      expectedInputId: inputId,
      expectedLoopRevision: loop.loop()!.revision,
      expectedBindGeneration: null,
      expectedBindStateRevision: 0,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000103",
        executionEpoch: 1,
        leaseOwner: "overlay-test-owner",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: JSON.stringify({ kind: "overlay_test" }),
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: null,
      },
      enqueueRegionalEffectsInTransaction: (deliveries) => {
        deliveryEffects.push(...deliveries.map((delivery) => ({
          inputId: delivery.inputId,
          activatedUserIds: delivery.activatedParticipants.map((participant) => participant.userId),
        })));
      },
      now: NOW + 3,
    };
    await expect(transcript.activatePendingInput(activation)).resolves.toMatchObject({
      outcome: "activated",
      transitions: [],
      turns: [{ turnId: inputId, actor: "human", transcriptSequence: 1, attentionOrdinal: 1 }],
    });
    expect(deliveryEffects).toEqual([{ inputId, activatedUserIds: ["user-1"] }]);
    expect(transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 4,
    }).pendingInputs).toEqual([]);
    expect(transcript.participantTurn(inputId)).toMatchObject({
      transcriptSequence: 1,
      attentionOrdinal: 1,
      blocks: [expect.objectContaining({
        text: "Hello @Ada",
        attachments: [expect.objectContaining({ id: attachmentId })],
        mentions: [expect.objectContaining({ userId: "user-2" })],
      })],
    });
    expect(sql.exec(
      `SELECT delivered_turn_id, delivered_attention_ordinal
         FROM delivered_loop_inputs WHERE input_id = ?`,
      inputId,
    ).one()).toEqual({
      delivered_turn_id: inputId,
      delivered_attention_ordinal: 1,
    });
    expect(sql.exec(
      `SELECT COUNT(*) AS count FROM pending_loop_inputs WHERE input_id = ?`,
      inputId,
    ).one()).toEqual({ count: 0 });
    expect(sql.exec(
      `SELECT COUNT(*) AS count FROM pending_loop_input_mailbox WHERE input_id = ?`,
      inputId,
    ).one()).toEqual({ count: 0 });
    expect(sql.exec(
      `SELECT COUNT(*) AS count FROM pending_attachment_reservation_recovery WHERE input_id = ?`,
      inputId,
    ).one()).toEqual({ count: 0 });
    expect(() => sql.exec(
      `UPDATE delivered_loop_inputs SET delivered_at = delivered_at + 1 WHERE input_id = ?`,
      inputId,
    )).toThrow("delivered_loop_input_is_immutable");
    expect(sql.exec(
      `SELECT latest_mention_attention_ordinal FROM member_attention WHERE user_id = 'user-2'`,
    ).one()).toEqual({ latest_mention_attention_ordinal: 1 });
    await expect(transcript.activatePendingInput({ ...activation, now: NOW + 5 }))
      .resolves.toMatchObject({
        outcome: "reused",
        transitions: [],
        turns: [{ turnId: inputId, transcriptSequence: 1, attentionOrdinal: 1 }],
      });
    expect(deliveryEffects).toHaveLength(1);
    expect(() => loop.reserveInputPreparation({
      inputId,
      loopId: "persistent-loop",
      clientMessageId: "client-pending-reused-after-delivery",
      preparationKind: "human_message",
      envelopeJson: JSON.stringify({ input: { text: "duplicate" } }),
      now: NOW + 6,
    })).toThrow("pending_input_already_delivered");
  });

  it("activates a system-actor input, the shape an automation's posted result arrives in", async () => {
    // The canonical payload of an activation carries the `system` role its
    // actor implies; what the model reads is the `user` bind payload. The
    // drain used to test the canonical role and throw, and a pending input
    // that throws stays first in line, so the room processed nothing after
    // the first result an automation posted into it.
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    // A room that has run before: the Bind head exists, so the activation is
    // appended to it through the same preparation every later steer takes.
    const { inputId, loop } = await admitPendingInput({
      storage,
      withAttachment: false,
      actor: "system",
      messageType: "automation_activation",
      text: "The weekly summary is ready.",
      bindContent: "An automation posted: The weekly summary is ready.",
    });
    await transcript.commitBindTransition(initializePersistentLoop(), NOW + 2);
    sql.exec(`UPDATE substream_loops SET bind_state_revision = 1 WHERE id = 1`);
    const activated = await transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: inputId,
      expectedLoopRevision: loop.loop()!.revision,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 1,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000104",
        executionEpoch: 1,
        leaseOwner: "system-input-owner",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: JSON.stringify({ kind: "system_input_test" }),
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "automation_activation",
        model: null,
      },
      enqueueRegionalEffectsInTransaction: () => undefined,
      now: NOW + 3,
    });
    expect(activated).toMatchObject({
      outcome: "activated",
      turns: [{ turnId: inputId, actor: "system", transcriptSequence: 1 }],
    });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM pending_loop_inputs`).one()).toEqual({ count: 0 });
    expect(transcript.participantTurn(inputId)).toMatchObject({ transcriptSequence: 1 });
  });

  it("does not reactivate a participant removed while an admitted input waits", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    sql.exec(
      `INSERT INTO participants
         (user_id, participation_reason, added_by_user_id, status, participant_epoch,
          added_at, removed_at, first_opened_at, updated_at)
       VALUES ('user-1', 'explicit', 'user-1', 'active', 0, ?, NULL, ?, ?)`,
      NOW,
      NOW,
      NOW,
    );
    const pending = await admitPendingInput({ storage, withAttachment: false });
    sql.exec(
      `UPDATE participants
          SET status = 'removed', removed_at = ?, participant_epoch = participant_epoch + 1,
              updated_at = ?
        WHERE user_id = 'user-1'`,
      NOW + 2,
      NOW + 2,
    );
    const deliveries: PendingInputDeliveryEffectInput[] = [];

    await expect(transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: pending.inputId,
      expectedLoopRevision: pending.loop.loop()!.revision,
      expectedBindGeneration: null,
      expectedBindStateRevision: 0,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000105",
        executionEpoch: 1,
        leaseOwner: "participant-removal-owner",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: JSON.stringify({ kind: "participant_removal_test" }),
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: null,
      },
      enqueueRegionalEffectsInTransaction: (effects) => { deliveries.push(...effects); },
      now: NOW + 3,
    })).resolves.toMatchObject({
      outcome: "activated",
      turns: [{ turnId: pending.inputId, actor: "human" }],
    });
    expect(sql.exec(
      `SELECT status, participant_epoch FROM participants WHERE user_id = 'user-1'`,
    ).one()).toEqual({ status: "removed", participant_epoch: 1 });
    expect(deliveries).toEqual([expect.objectContaining({
      authorUserId: "user-1",
      // The removed author stays removed. The independently valid workspace-
      // scoped mention still reaches its existing workspace member.
      affectedUserIds: ["user-2"],
      activatedParticipants: [],
    })]);
  });

  it("reuses a mutable work-stream resource projection while preserving the admitted attachment", async () => {
    const { transcript, sql, storage, database } = open();
    seedPendingInputRoot(sql);
    const { inputId, attachmentId, loop } = await admitPendingInput({ storage });
    const currentResourceJson = JSON.stringify({
      id: attachmentId,
      title: "renamed-evidence.pdf",
      mimeType: "application/pdf",
      metadata: { size: 84 },
    });
    sql.exec(
      `INSERT INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type,
          resource_json, attached_at, updated_at)
       VALUES (?, 'user-1', 1, 'message_attachment', ?, ?, ?)`,
      attachmentId,
      currentResourceJson,
      NOW,
      NOW,
    );

    await expect(transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: inputId,
      expectedLoopRevision: loop.loop()!.revision,
      expectedBindGeneration: null,
      expectedBindStateRevision: 0,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000104",
        executionEpoch: 1,
        leaseOwner: "attachment-reuse-owner",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: JSON.stringify({ kind: "attachment_reuse_test" }),
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: null,
      },
      enqueueRegionalEffectsInTransaction: () => undefined,
      now: NOW + 3,
    })).resolves.toMatchObject({ outcome: "activated", removedInputIds: [inputId] });
    expect(sql.exec(
      `SELECT watch_enabled, resource_json FROM workstream_resource_links WHERE resource_id = ?`,
      attachmentId,
    ).one()).toEqual({ watch_enabled: 1, resource_json: currentResourceJson });
    expect(sql.exec(
      `SELECT attachment_json FROM participant_transcript_attachments
        WHERE turn_id = ? AND resource_id = ?`,
      inputId,
      attachmentId,
    ).one()).toEqual({
      attachment_json: JSON.stringify({ attachedAt: new Date(NOW + 1).toISOString() }),
    });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM pending_loop_inputs WHERE input_id = ?`, inputId).one())
      .toEqual({ count: 0 });
    expect(sql.exec(`SELECT delivered_turn_id FROM delivered_loop_inputs WHERE input_id = ?`, inputId).one())
      .toEqual({ delivered_turn_id: inputId });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM runs`).one()).toEqual({ count: 1 });
    expect(loop.loop()).toMatchObject({ status: "executing", bind_state_revision: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("activates the first pending input before a Bind head exists and initializes from canonical history", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    const pending = await admitPendingInput({ storage, withAttachment: false });
    const activated = await transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: pending.inputId,
      expectedLoopRevision: pending.loop.loop()!.revision,
      expectedBindGeneration: null,
      expectedBindStateRevision: 0,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000109",
        executionEpoch: 1,
        leaseOwner: "lease-bootstrap",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: JSON.stringify({ kind: "test_bootstrap" }),
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: () => undefined,
      now: NOW + 2,
    });
    expect(activated).toMatchObject({
      outcome: "activated",
      transitions: [],
      removedInputIds: [pending.inputId],
      loop: { status: "executing", bind_state_revision: 0 },
    });
    expect(transcript.readBindProjection("persistent-loop")).toBeNull();
    expect(transcript.participantTurn(pending.inputId)).toMatchObject({
      turnId: pending.inputId,
      blocks: [expect.objectContaining({ text: "Hello @Ada" })],
    });

    await transcript.commitBindTransition({
      ...initializePersistentLoop(),
      nonSystemMessages: [{
        role: "user",
        content: "Hello @Ada",
        structuredContent: { source: "test" },
      }],
      nonSystemMessageOrigins: [{
        originKind: "derived",
        sourceKind: "participant_turn",
        sourceId: pending.inputId,
        sourceRevision: 1,
      }],
    }, NOW + 3, {
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-bootstrap",
      expectedBindStateRevision: 0,
    });
    expect(transcript.readBindProjection("persistent-loop")!.stateRevision).toBe(1);
    expect(pending.loop.loop()!.bind_state_revision).toBe(1);
  });

  it("commits ordered semantic realtime references with pending admission and delivery", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    sql.exec(
      `INSERT INTO substreams
         (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
       VALUES ('child-1', 'agent', 'none', 1, 'none', 'workspace', 'full', 'open', ?)`,
      NOW,
    );
    const pending = await admitPendingInput({ storage, withAttachment: false });
    await transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: pending.inputId,
      expectedLoopRevision: pending.loop.loop()!.revision,
      expectedBindGeneration: null,
      expectedBindStateRevision: 0,
      receipt: {
        substreamId: "child-1",
        runId: "00000000-0000-7000-8000-00000000010a",
        executionEpoch: 1,
        leaseOwner: "child-receipt-owner",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: JSON.stringify({ kind: "child_execution" }),
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: null,
      },
      enqueueRegionalEffectsInTransaction: () => undefined,
      now: NOW + 2,
    });

    const rows = sql.exec<{
      source_version: number;
      payload_json: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT source_version, payload_json FROM durable_outbox
        WHERE channel = 'semantic_realtime_v1' ORDER BY source_version`,
    ).toArray();
    expect(rows.map((row) => ({
      sequence: row.source_version,
      reference: (JSON.parse(row.payload_json) as { reference: unknown }).reference,
    }))).toEqual([
      { sequence: 1, reference: { kind: "loop_input_upserted", inputId: pending.inputId } },
      { sequence: 2, reference: { kind: "transcript_turn", turnId: pending.inputId } },
      {
        sequence: 3,
        reference: { kind: "loop_input_removed", inputId: pending.inputId, outcome: "delivered" },
      },
    ]);
    expect(sql.exec(`SELECT event_sequence FROM realtime_state WHERE id = 1`).one())
      .toEqual({ event_sequence: 3 });
    expect(sql.exec(`SELECT substream_id FROM runs`).one()).toEqual({ substream_id: "child-1" });
  });

  it("rolls a canonical turn back when its semantic realtime intent cannot commit", async () => {
    const { transcript, sql } = open();
    seedPendingInputRoot(sql);
    sql.exec(
      `CREATE TRIGGER reject_semantic_realtime_outbox
       BEFORE INSERT ON durable_outbox
       WHEN NEW.channel = 'semantic_realtime_v1'
       BEGIN
         SELECT RAISE(ABORT, 'forced_semantic_realtime_failure');
       END`,
    );

    await expect(transcript.appendParticipantMessage({
      turnId: "atomic-turn",
      actor: "system",
      authorUserId: null,
      authorSnapshot: null,
      text: "Must not become visible without its durable publication intent",
      createdAtUtc: new Date(NOW + 1).toISOString(),
      attentionOrdinal: 1,
    })).rejects.toThrow("forced_semantic_realtime_failure");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns`).one())
      .toEqual({ count: 0 });
    expect(sql.exec(`SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`).one())
      .toEqual({ next_transcript_sequence: 1 });
    expect(sql.exec(`SELECT event_sequence FROM realtime_state WHERE id = 1`).toArray())
      .toEqual([]);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM durable_outbox`).one()).toEqual({ count: 0 });
  });

  it("accepts only an exact provider-boundary replay", async () => {
    const { transcript, sql } = open();
    await transcript.commitBindTransition(initializePersistentLoop(), NOW);
    const boundary = {
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 1,
      systemProjectionRevision: 1,
      projectorVersion: "bind-loop-v1",
      projectedHash: "hash-one",
      bindHash: "hash-one",
    };
    transcript.recordProviderBoundary(boundary, NOW + 1);
    expect(() => transcript.recordProviderBoundary(boundary, NOW + 2)).not.toThrow();
    for (const changed of [
      { projectedHash: "hash-two", bindHash: "hash-two" },
      { generation: 2 },
      { systemProjectionRevision: 2 },
      { projectorVersion: "bind-loop-v2" },
    ]) {
      expect(() => transcript.recordProviderBoundary({ ...boundary, ...changed }, NOW + 3))
        .toThrow("bind_provider_boundary_replay_conflict");
    }
    expect(sql.exec(
      `SELECT generation, system_projection_revision, projector_version,
              projected_hash, bind_hash, verified_at
         FROM bind_provider_boundaries`,
    ).one()).toEqual({
      generation: 1,
      system_projection_revision: 1,
      projector_version: "bind-loop-v1",
      projected_hash: "hash-one",
      bind_hash: "hash-one",
      verified_at: NOW + 1,
    });
  });

  it("commits only missing activation identities before inference and replays without content comparison", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    await transcript.commitBindTransition({
      ...initializePersistentLoop(),
      nonSystemMessages: [{ role: "user", content: "Question" }],
      nonSystemMessageOrigins: [{
        originKind: "derived",
        sourceKind: "participant_turn",
        sourceId: "turn-existing",
        sourceRevision: 1,
      }],
    }, NOW);
    const loop = new SubstreamLoopStorage(storage);
    loop.ensureLoop({ loopId: "persistent-loop", bindStateRevision: 1, now: NOW });
    const runId = "00000000-0000-7000-8000-000000000110";
    const runs = new WorkstreamHarnessRunStorage(storage);
    expect(runs.admitRun({
      runId,
      origin: "member_message",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
      status: "running",
      startedAt: NOW,
      model: "test/model",
      triggerPartId: null,
      parentRunId: null,
      expectedLatestRunId: null,
      now: NOW,
    })).toEqual({ outcome: "admitted" });
    sql.exec(
      `UPDATE runs SET execution_context_json = '{"kind":"test_execution"}' WHERE run_id = ?`,
      runId,
    );
    loop.activateExecutionReceipt({
      runId,
      loopId: "persistent-loop",
      executionEpoch: 1,
      leaseOwner: "activation-owner",
      leaseExpiresAt: NOW + 60_000,
      expectedLoopRevision: loop.loop()!.revision,
      expectedBindStateRevision: 1,
      now: NOW,
    });
    const originalSequences = sql.exec(
      `SELECT message_position, loop_sequence FROM bind_loop_state_messages
        WHERE loop_id = 'persistent-loop' ORDER BY message_position`,
    ).toArray();
    const originalQuestionFactId = sql.exec<{ fact_id: string } & Record<string, SqlStorageValue>>(
      `SELECT fact_id FROM bind_loop_state_messages
        WHERE loop_id = 'persistent-loop' AND message_position = 1`,
    ).one().fact_id;
    const inputs = [{
      activationInputId: "participant_turn:turn-existing:1",
      message: {
        role: "user" as const,
        content: "Different bytes are irrelevant because the source already exists",
        provenance: {
          originKind: "derived" as const,
          sourceKind: "participant_turn",
          sourceId: "turn-existing",
          sourceRevision: 1,
        },
      },
    }, {
      activationInputId: "participant_turn:turn-two:1",
      message: {
        role: "user" as const,
        content: "Question",
        provenance: {
          originKind: "derived" as const,
          sourceKind: "participant_turn",
          sourceId: "turn-two",
          sourceRevision: 1,
        },
      },
    }, {
      activationInputId: "scheduled_wakeup:wakeup-three:3",
      message: {
        role: "user" as const,
        content: "Third input",
        provenance: {
          originKind: "derived" as const,
          sourceKind: "scheduled_wakeup",
          sourceId: "wakeup-three",
          sourceRevision: 3,
        },
      },
    }];
    const committed = await transcript.commitActivationInputs({
      loopId: "persistent-loop",
      executionId: runId,
      executionEpoch: 1,
      leaseOwner: "activation-owner",
      expectedBindGeneration: 1,
      expectedBindStateRevision: 1,
      inputs,
      now: NOW + 1,
    });
    expect(committed.transitions.map((transition) => ({
      activationInputId: transition.activationInputId,
      stateRevision: transition.stateRevision,
    }))).toEqual([
      { activationInputId: "participant_turn:turn-two:1", stateRevision: 2 },
      { activationInputId: "scheduled_wakeup:wakeup-three:3", stateRevision: 3 },
    ]);
    expect(committed.replayedActivationInputIds).toEqual([
      "participant_turn:turn-existing:1",
    ]);
    const projection = transcript.readBindProjection("persistent-loop");
    expect(projection && bindLoopNonSystemMessages(projection)
      .map((message) => message.content)).toEqual(["Question", "Question", "Third input"]);
    expect(loop.loop()).toMatchObject({ bind_state_revision: 3 });
    expect(sql.exec(
      `SELECT receipt.activation_input_id, fact.source_kind, fact.source_id, fact.source_revision
         FROM bind_activation_inputs receipt
         JOIN transcript_facts fact ON fact.fact_id = receipt.fact_id
        WHERE receipt.loop_id = 'persistent-loop'
        ORDER BY receipt.admitted_state_revision`,
    ).toArray()).toEqual([
      {
        activation_input_id: "participant_turn:turn-existing:1",
        source_kind: "participant_turn",
        source_id: "turn-existing",
        source_revision: 1,
      },
      {
        activation_input_id: "participant_turn:turn-two:1",
        source_kind: "participant_turn",
        source_id: "turn-two",
        source_revision: 1,
      },
      {
        activation_input_id: "scheduled_wakeup:wakeup-three:3",
        source_kind: "scheduled_wakeup",
        source_id: "wakeup-three",
        source_revision: 3,
      },
    ]);
    expect(sql.exec(
      `SELECT message_position, loop_sequence FROM bind_loop_state_messages
        WHERE loop_id = 'persistent-loop' AND message_position < 2
        ORDER BY message_position`,
    ).toArray()).toEqual(originalSequences);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM bind_loop_heads`).one().count).toBe(1);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM bind_loop_state_messages`).one().count).toBe(4);

    await transcript.commitBindTransition({
      kind: "state_replaced",
      loopId: "persistent-loop",
      generation: 1,
      nextGeneration: 2,
      stateRevision: 4,
      compactionEventId: "persistent-loop:compaction:1",
      systemProjection,
      // Identical bytes are still a new protocol fact with compaction
      // provenance; content equality is never transition identity.
      nonSystemMessages: [{ role: "user", content: "Question" }],
    }, NOW + 2, {
      executionId: runId,
      executionEpoch: 1,
      leaseOwner: "activation-owner",
      expectedBindStateRevision: 3,
    });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM bind_loop_heads`).one().count).toBe(1);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM bind_loop_state_messages`).one().count).toBe(2);
    expect(sql.exec<{
      fact_id: string;
      origin_kind: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT projected.fact_id, fact.origin_kind
         FROM bind_loop_state_messages projected
         JOIN transcript_facts fact ON fact.fact_id = projected.fact_id
        WHERE projected.loop_id = 'persistent-loop' AND projected.message_position = 1`,
    ).one()).toEqual({
      fact_id: "persistent-loop:state:4:message:1",
      origin_kind: "protocol",
    });
    expect(originalQuestionFactId).not.toBe("persistent-loop:state:4:message:1");
    const revisionBeforeReplay = loop.loop()!.revision;
    await expect(transcript.commitActivationInputs({
      loopId: "persistent-loop",
      executionId: runId,
      executionEpoch: 1,
      leaseOwner: "activation-owner",
      expectedBindGeneration: 2,
      expectedBindStateRevision: 4,
      inputs,
      now: NOW + 3,
    })).resolves.toEqual({
      transitions: [],
      replayedActivationInputIds: inputs.map((entry) => entry.activationInputId),
    });
    expect(loop.loop()!.revision).toBe(revisionBeforeReplay);
    await expect(transcript.commitActivationInputs({
      loopId: "persistent-loop",
      executionId: runId,
      executionEpoch: 1,
      leaseOwner: "activation-owner",
      expectedBindGeneration: 2,
      expectedBindStateRevision: 4,
      inputs: [{
        ...inputs[0]!,
        message: { ...inputs[0]!.message, content: "Mutated replay payload" },
      }],
      now: NOW + 4,
    })).rejects.toThrow("bind_activation_input_replay_mismatch");
  });

  it("revalidates a cached Bind projection across storage instances and never caches a rolled-back head", async () => {
    const { transcript, storage, sql } = open();
    const independent = new WorkstreamTranscriptStorage(storage);
    await transcript.commitBindTransition({
      ...initializePersistentLoop(),
      nonSystemMessages: [{ role: "user", content: "Question" }],
      nonSystemMessageOrigins: [{
        originKind: "derived",
        sourceKind: "participant_turn",
        sourceId: "message-1",
        sourceRevision: 1,
      }],
    }, NOW);
    await independent.commitBindTransition({
      kind: "system_projection_changed",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 2,
      systemProjection: {
        ...systemProjection,
        revision: 2,
        inputHash: "system-input-two",
      },
    }, NOW + 1);
    const refreshed = transcript.readBindProjection("persistent-loop")!;
    expect(refreshed).toMatchObject({ stateRevision: 2 });
    expect(bindLoopNonSystemMessages(refreshed)).toEqual([{ role: "user", content: "Question" }]);

    await transcript.commitBindTransition({
      kind: "assistant_reserved",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 3,
      turnId: "persistent-loop:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
    }, NOW + 2);
    await expect(transcript.commitBindTransition({
      kind: "assistant_accepted",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 4,
      turnId: "persistent-loop:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
      message: { role: "assistant", content: "Must roll back" },
    }, NOW + 3)).rejects.toThrow("workstream_assistant_reservation_mismatch");

    expect(sql.exec(
      `SELECT state_revision FROM bind_loop_heads WHERE loop_id = 'persistent-loop'`,
    ).one()).toEqual({ state_revision: 3 });
    const afterRollback = transcript.readBindProjection("persistent-loop")!;
    expect(afterRollback.stateRevision).toBe(3);
    expect(bindLoopNonSystemMessages(afterRollback)).toEqual([
      { role: "user", content: "Question" },
    ]);
  });

  it.each(["during", "after"] as const)("activates one idle input and delivers every later steer in one ordered step commit (late input %s settlement)", async (lateInputTiming) => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    const first = await admitPendingInput({ storage });
    await transcript.commitBindTransition(initializePersistentLoop(), NOW + 2);
    sql.exec(`UPDATE substream_loops SET bind_state_revision = 1 WHERE id = 1`);
    const activationEffects: string[] = [];
    const activated = await transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: first.inputId,
      expectedLoopRevision: first.loop.loop()!.revision,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 1,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000111",
        executionEpoch: 1,
        leaseOwner: "lease-1",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: JSON.stringify({ kind: "test_execution", loopId: "persistent-loop" }),
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: (deliveries) => {
        activationEffects.push(...deliveries.map((delivery) => delivery.inputId));
      },
      now: NOW + 3,
    });
    expect(activated).toMatchObject({
      outcome: "activated",
      removedInputIds: [first.inputId],
      loop: { status: "executing", cycle_ordinal: 1, bind_state_revision: 2 },
    });
    expect(activationEffects).toEqual([first.inputId]);
    expect(sql.exec(
      `SELECT attempt_epoch, substream_loop_id, loop_input_id, loop_execution_epoch,
              execution_context_json, execution_available_at
         FROM runs WHERE run_id = ?`,
      activated.receiptRunId,
    ).one()).toEqual({
      attempt_epoch: 0,
      substream_loop_id: "persistent-loop",
      loop_input_id: first.inputId,
      loop_execution_epoch: 1,
      execution_context_json: JSON.stringify({ kind: "test_execution", loopId: "persistent-loop" }),
      execution_available_at: null,
    });

    const loop = first.loop.loop()!;
    const assistantTurnId = "persistent-loop:turn:1";
    const reservation = first.loop.reserveAssistantTurn({
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
      expectedLoopRevision: loop.revision,
      receiptRunId: activated.receiptRunId,
      turnId: assistantTurnId,
      modelTurnIndex: 1,
      streamId: "stream-1",
      now: NOW + 4,
    });
    expect(reservation.outcome).toBe("reserved");
    await transcript.commitBindTransition({
      kind: "assistant_reserved",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 3,
      turnId: assistantTurnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
    }, NOW + 5, {
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
      expectedBindStateRevision: 2,
    });
    await transcript.commitBindTransition({
      kind: "assistant_accepted",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 4,
      turnId: assistantTurnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
      message: { role: "assistant", content: "First answer" },
    }, NOW + 6, {
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
      expectedBindStateRevision: 3,
    });

    const second = await admitPendingInput({
      storage,
      inputId: "00000000-0000-7000-8000-000000000121",
      clientMessageId: "client-pending-2",
      text: "Second @Ada",
      bindContent: "Provider-facing second message",
      withAttachment: false,
    });
    const third = await admitPendingInput({
      storage,
      inputId: "00000000-0000-7000-8000-000000000131",
      clientMessageId: "client-pending-3",
      text: "Third @Ada",
      withAttachment: false,
    });
    const stepEffects: string[] = [];
    const settledPromise = transcript.settlePendingSteersAtStep({
      loopId: "persistent-loop",
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
      expectedLoopRevision: third.loop.loop()!.revision,
      expectedStepOrdinal: 0,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 4,
      assistantTurnId,
      modelTurnIndex: 1,
      enqueueRegionalEffectsInTransaction: (deliveries) => {
        stepEffects.push(...deliveries.map((delivery) => delivery.inputId));
      },
      now: NOW + 9,
    });
    // Exercise both arrival orders without assuming which async preparation
    // wins. In the after case, admission necessarily advances the revision
    // beyond the snapshot returned by settlement.
    if (lateInputTiming === "after") await settledPromise;
    const lateDuringSettlement = await admitPendingInput({
      storage,
      inputId: "00000000-0000-7000-8000-000000000141",
      clientMessageId: "client-pending-late",
      text: "Late boundary steer @Ada",
      withAttachment: false,
    });
    const settled = await settledPromise;
    expect(settled.removedInputIds).toEqual([second.inputId, third.inputId]);
    expect(settled.transitions.map((transition) => transition.message.content))
      .toEqual(["Provider-facing second message", "Third @Ada"]);
    expect(stepEffects).toEqual([second.inputId, third.inputId]);
    expect(sql.exec(
      `SELECT input_id FROM pending_loop_inputs WHERE input_id = ?`,
      lateDuringSettlement.inputId,
    ).one()).toEqual({ input_id: lateDuringSettlement.inputId });
    expect(settled.loop).toMatchObject({
      status: "executing",
      cycle_ordinal: 1,
      step_ordinal: 1,
      bind_state_revision: 6,
    });
    const projection = transcript.readBindProjection("persistent-loop");
    expect(projection && bindLoopNonSystemMessages(projection)
      .map((message) => message.content)).toEqual([
      "Hello @Ada",
      "First answer",
      "Provider-facing second message",
      "Third @Ada",
    ]);
    expect(sql.exec(
      `SELECT seen_attention_ordinal FROM member_attention WHERE user_id = 'user-1'`,
    ).one()).toEqual({ seen_attention_ordinal: 3 });

    const secondAssistantTurnId = "persistent-loop:turn:2";
    const secondReservation = first.loop.reserveAssistantTurn({
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
      // Match AgentLoopDO's fresh fence read. The late input may commit
      // after settlement and legitimately advance the loop revision.
      expectedLoopRevision: first.loop.loop()!.revision,
      receiptRunId: activated.receiptRunId,
      turnId: secondAssistantTurnId,
      modelTurnIndex: 2,
      // One execution stream contains every model turn in this loop cycle.
      // Reusing it is the production path and must never collide with another
      // assistant reservation.
      streamId: "stream-1",
      now: NOW + 10,
    });
    await transcript.commitBindTransition({
      kind: "assistant_reserved",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 7,
      turnId: secondAssistantTurnId,
      modelTurnIndex: 2,
      transcriptSequence: secondReservation.reservation.transcript_sequence,
    }, NOW + 11, {
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
      expectedBindStateRevision: 6,
    });
    await transcript.commitBindTransition({
      kind: "assistant_accepted",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 8,
      turnId: secondAssistantTurnId,
      modelTurnIndex: 2,
      transcriptSequence: secondReservation.reservation.transcript_sequence,
      message: { role: "assistant", content: "Second answer" },
    }, NOW + 12, {
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
      expectedBindStateRevision: 7,
    });
    expect(sql.exec(
      `SELECT turn_id, assistant_turn_sequence, state, outcome
         FROM assistant_turn_reservations
        WHERE loop_id = 'persistent-loop' ORDER BY assistant_turn_sequence`,
    ).toArray()).toEqual([
      {
        turn_id: assistantTurnId,
        assistant_turn_sequence: 1,
        state: "materialized",
        outcome: "accepted",
      },
      {
        turn_id: secondAssistantTurnId,
        assistant_turn_sequence: 2,
        state: "materialized",
        outcome: "accepted",
      },
    ]);
    const deferred = await admitPendingInput({
      storage,
      inputId: "00000000-0000-7000-8000-000000000151",
      clientMessageId: "client-pending-after-stop",
      text: "Use this next time @Ada",
      withAttachment: false,
    });
    const beforeStop = deferred.loop.loop()!;
    const stoppedPromise = transcript.settlePendingSteersAtStep({
      loopId: "persistent-loop",
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
      expectedLoopRevision: beforeStop.revision,
      expectedStepOrdinal: 1,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 8,
      assistantTurnId: secondAssistantTurnId,
      modelTurnIndex: 2,
      enqueueRegionalEffectsInTransaction: (deliveries) => {
        if (deliveries.length > 0) {
          throw new Error("stopped step must not enqueue pending steer effects");
        }
      },
      now: NOW + 15,
    });
    // Settlement has already captured and begun preparing this steer when the
    // stop commits. The safe boundary must let the stop win without returning
    // the uncommitted transition or consuming the pending input.
    const requestedStop = storage.transactionSync(() => first.loop.requestStopInTransaction({
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
      expectedLoopRevision: beforeStop.revision,
      reason: "member_requested",
      now: NOW + 14,
    }));
    expect(requestedStop.stop_requested_at).toBe(NOW + 14);
    const stopped = await stoppedPromise;
    expect(stopped).toMatchObject({
      transitions: [],
      removedInputIds: [],
      stop: true,
      loop: { status: "executing", bind_state_revision: 8, step_ordinal: 2 },
    });
    expect(sql.exec(
      `SELECT input_id FROM pending_loop_inputs WHERE input_id = ?`,
      deferred.inputId,
    ).one()).toEqual({ input_id: deferred.inputId });
    expect(sql.exec(
      `SELECT status, terminal_reason, final_turn_id, terminalized_at
         FROM runs WHERE run_id = ?`,
      activated.receiptRunId,
    ).one()).toEqual({
      status: "running",
      terminal_reason: null,
      final_turn_id: null,
      terminalized_at: null,
    });
  });

  it("holds a steer sent after a waiting room message until that message has landed", async () => {
    // [steer A, room message B, steer C]. Promoting both steers and then landing
    // B would read A, C, B — C ahead of a message sent before it.
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    const first = await admitPendingInput({ storage });
    await transcript.commitBindTransition(initializePersistentLoop(), NOW + 2);
    sql.exec(`UPDATE substream_loops SET bind_state_revision = 1 WHERE id = 1`);
    const activated = await transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: first.inputId,
      expectedLoopRevision: first.loop.loop()!.revision,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 1,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000111",
        executionEpoch: 1,
        leaseOwner: "lease-1",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: JSON.stringify({ kind: "test_execution", loopId: "persistent-loop" }),
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: () => {},
      now: NOW + 3,
    });
    const assistantTurnId = "persistent-loop:turn:1";
    const reservation = first.loop.reserveAssistantTurn({
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
      expectedLoopRevision: first.loop.loop()!.revision,
      receiptRunId: activated.receiptRunId,
      turnId: assistantTurnId,
      modelTurnIndex: 1,
      streamId: "stream-1",
      now: NOW + 4,
    });
    const fence = {
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
    };
    await transcript.commitBindTransition({
      kind: "assistant_reserved",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 3,
      turnId: assistantTurnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
    }, NOW + 5, { ...fence, expectedBindStateRevision: 2 });
    await transcript.commitBindTransition({
      kind: "assistant_accepted",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 4,
      turnId: assistantTurnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
      message: { role: "assistant", content: "First answer" },
    }, NOW + 6, { ...fence, expectedBindStateRevision: 3 });

    const steerA = await admitPendingInput({
      storage, inputId: "00000000-0000-7000-8000-000000000121",
      clientMessageId: "client-steer-a", text: "Steer A @Ada", withAttachment: false,
    });
    const roomB = await admitPendingInput({
      storage, inputId: "00000000-0000-7000-8000-000000000131",
      clientMessageId: "client-room-b", text: "Room B @Ada", withAttachment: false, startsRun: false,
    });
    const steerC = await admitPendingInput({
      storage, inputId: "00000000-0000-7000-8000-000000000141",
      clientMessageId: "client-steer-c", text: "Steer C @Ada", withAttachment: false,
    });
    const settled = await transcript.settlePendingSteersAtStep({
      loopId: "persistent-loop",
      ...fence,
      expectedLoopRevision: steerC.loop.loop()!.revision,
      expectedStepOrdinal: 0,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 4,
      assistantTurnId,
      modelTurnIndex: 1,
      enqueueRegionalEffectsInTransaction: () => {},
      now: NOW + 9,
    });

    expect(settled.removedInputIds).toEqual([steerA.inputId, roomB.inputId]);
    // The step that answers A reads B after it, as something said to the room.
    const appended = settled.transitions.map((transition) => JSON.stringify(transition.message.content));
    expect(appended).toHaveLength(2);
    expect(appended[0]).toContain("Steer A @Ada");
    expect(appended[1]).toContain("Room B @Ada");
    expect(appended[1]).toContain("SAID TO THE ROOM");
    expect(sql.exec<{ input_id: string }>(`SELECT input_id FROM pending_loop_inputs`).toArray())
      .toEqual([{ input_id: steerC.inputId }]);
    expect(sql.exec<{ turn_id: string }>(
      `SELECT turn_id FROM participant_transcript_turns WHERE turn_id IN (?, ?)
        ORDER BY transcript_sequence`,
      steerA.inputId,
      roomB.inputId,
    ).toArray().map((row) => row.turn_id)).toEqual([steerA.inputId, roomB.inputId]);
    // Directly under A: nothing lands between them.
    expect(sql.exec<{ gap: number }>(
      `SELECT b.transcript_sequence - a.transcript_sequence AS gap
         FROM participant_transcript_turns AS a, participant_transcript_turns AS b
        WHERE a.turn_id = ? AND b.turn_id = ?`,
      steerA.inputId,
      roomB.inputId,
    ).one().gap).toBe(1);
  });

  it("records the Slack origin of each steer a run absorbs, against that run", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    const first = await admitPendingInput({ storage });
    await transcript.commitBindTransition(initializePersistentLoop(), NOW + 2);
    sql.exec(`UPDATE substream_loops SET bind_state_revision = 1 WHERE id = 1`);
    const activated = await transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: first.inputId,
      expectedLoopRevision: first.loop.loop()!.revision,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 1,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000111",
        executionEpoch: 1,
        leaseOwner: "lease-1",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: JSON.stringify({ kind: "test_execution", loopId: "persistent-loop" }),
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: () => {},
      now: NOW + 3,
    });
    const assistantTurnId = "persistent-loop:turn:1";
    const reservation = first.loop.reserveAssistantTurn({
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
      expectedLoopRevision: first.loop.loop()!.revision,
      receiptRunId: activated.receiptRunId,
      turnId: assistantTurnId,
      modelTurnIndex: 1,
      streamId: "stream-1",
      now: NOW + 4,
    });
    const fence = {
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-1",
    };
    await transcript.commitBindTransition({
      kind: "assistant_reserved",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 3,
      turnId: assistantTurnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
    }, NOW + 5, { ...fence, expectedBindStateRevision: 2 });
    await transcript.commitBindTransition({
      kind: "assistant_accepted",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 4,
      turnId: assistantTurnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
      message: { role: "assistant", content: "First answer" },
    }, NOW + 6, { ...fence, expectedBindStateRevision: 3 });

    const origin = { teamId: "T1", channelId: "C1", reactionAnchor: { channelId: "C1", messageTs: "9.0" } };
    await admitPendingInput({
      storage, inputId: "00000000-0000-7000-8000-000000000121",
      clientMessageId: "client-steer-slack", text: "From Slack @Ada", withAttachment: false,
      slackOrigin: origin,
    });
    const plain = await admitPendingInput({
      storage, inputId: "00000000-0000-7000-8000-000000000141",
      clientMessageId: "client-steer-plain", text: "From Rally @Ada", withAttachment: false,
    });
    await transcript.settlePendingSteersAtStep({
      loopId: "persistent-loop",
      ...fence,
      expectedLoopRevision: plain.loop.loop()!.revision,
      expectedStepOrdinal: 0,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 4,
      assistantTurnId,
      modelTurnIndex: 1,
      enqueueRegionalEffectsInTransaction: () => {},
      now: NOW + 9,
    });

    expect(transcript.absorbedSlackOrigins(activated.receiptRunId)).toEqual([origin]);
    expect(transcript.absorbedSlackOrigins("00000000-0000-7000-8000-000000000999")).toEqual([]);
  });

  it("atomically closes a withheld elicitation tool call before promoting its answer", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    const initial = await admitPendingInput({ storage, withAttachment: false });
    await transcript.commitBindTransition(initializePersistentLoop(), NOW + 2);
    sql.exec(`UPDATE substream_loops SET bind_state_revision = 1 WHERE id = 1`);
    const activated = await transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: initial.inputId,
      expectedLoopRevision: initial.loop.loop()!.revision,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 1,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000171",
        executionEpoch: 1,
        leaseOwner: "elicitation-owner",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: "{}",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: () => undefined,
      now: NOW + 3,
    });
    const turnId = "persistent-loop:turn:1";
    const reservation = initial.loop.reserveAssistantTurn({
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "elicitation-owner",
      expectedLoopRevision: activated.loop.revision,
      receiptRunId: activated.receiptRunId,
      turnId,
      modelTurnIndex: 1,
      streamId: "elicitation-stream",
      now: NOW + 4,
    });
    await transcript.commitBindTransition({
      kind: "assistant_reserved",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 3,
      turnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
    }, NOW + 5, {
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "elicitation-owner",
      expectedBindStateRevision: 2,
    });
    await transcript.commitBindTransition({
      kind: "assistant_accepted",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 4,
      turnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "provider-elicitation-call",
          type: "function",
          function: { name: "request_elicitation", arguments: "{}" },
        }],
      },
    }, NOW + 6, {
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "elicitation-owner",
      expectedBindStateRevision: 3,
    });
    const elicitationId = "elicitation-1";
    sql.exec(
      `INSERT INTO elicitation_requests
         (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
          minimum_selections, maximum_selections, target_user_id, status, answer_json,
          answered_by_user_id, external_actor_json, created_at, answered_at)
       VALUES (?, ?, ?, 'Which environment?', 'text', '[]', 0, NULL, NULL,
               'answered', ?, 'user-1', NULL, ?, ?)`,
      elicitationId,
      activated.receiptRunId,
      `${turnId}:tool:0`,
      JSON.stringify("staging"),
      NOW + 6,
      NOW + 7,
    );
    const answer = await admitPendingInput({
      storage,
      inputId: "00000000-0000-7000-8000-000000000172",
      clientMessageId: "elicitation-response:elicitation-1",
      text: "Answered staging @Ada",
      bindContent: "The person answered staging.",
      withAttachment: false,
      messageType: "elicitation",
      elicitationId,
    });

    const settled = await transcript.settlePendingSteersAtStep({
      loopId: "persistent-loop",
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "elicitation-owner",
      expectedLoopRevision: answer.loop.loop()!.revision,
      expectedStepOrdinal: 0,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 4,
      assistantTurnId: turnId,
      modelTurnIndex: 1,
      enqueueRegionalEffectsInTransaction: () => undefined,
      now: NOW + 9,
    });

    expect(settled.transitions.map((transition) => transition.kind))
      .toEqual(["tool_result_accepted"]);
    expect(settled.transitions[0]).toMatchObject({
      callIndex: 0,
      resultOrdinal: 0,
      message: {
        role: "tool",
        tool_call_id: "provider-elicitation-call",
      },
    });
    const projected = bindLoopNonSystemMessages(transcript.readBindProjection("persistent-loop")!);
    expect(projected).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "provider-elicitation-call" }),
    ]));
    expect(projected).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "The person answered staging." }),
    ]));
    expect(JSON.parse(String(projected.at(-1)?.content))).toMatchObject({
      success: true,
      data: { elicitationId, answer: "staging" },
    });
    expect(transcript.participantTurn(answer.inputId)).toMatchObject({
      turnId: answer.inputId,
      actor: "human",
    });
    expect(settled.loop.bind_state_revision).toBe(5);
  });

  it("activates the answer to a withheld question ahead of a message queued before it", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    const initial = await admitPendingInput({ storage, withAttachment: false });
    await transcript.commitBindTransition(initializePersistentLoop(), NOW + 2);
    sql.exec(`UPDATE substream_loops SET bind_state_revision = 1 WHERE id = 1`);
    const activated = await transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: initial.inputId,
      expectedLoopRevision: initial.loop.loop()!.revision,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 1,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000181",
        executionEpoch: 1,
        leaseOwner: "queued-owner",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: "{}",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: () => undefined,
      now: NOW + 3,
    });
    const turnId = "persistent-loop:turn:1";
    const reservation = initial.loop.reserveAssistantTurn({
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "queued-owner",
      expectedLoopRevision: activated.loop.revision,
      receiptRunId: activated.receiptRunId,
      turnId,
      modelTurnIndex: 1,
      streamId: "queued-stream",
      now: NOW + 4,
    });
    await transcript.commitBindTransition({
      kind: "assistant_reserved",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 3,
      turnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
    }, NOW + 5, {
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "queued-owner",
      expectedBindStateRevision: 2,
    });
    await transcript.commitBindTransition({
      kind: "assistant_accepted",
      loopId: "persistent-loop",
      generation: 1,
      stateRevision: 4,
      turnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "provider-elicitation-call",
          type: "function",
          function: { name: "request_elicitation", arguments: "{}" },
        }],
      },
    }, NOW + 6, {
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "queued-owner",
      expectedBindStateRevision: 3,
    });

    const queued = await admitPendingInput({
      storage,
      inputId: "00000000-0000-7000-8000-000000000182",
      clientMessageId: "client-queued-1",
      text: "Also check staging @Ada",
      bindContent: "Also check staging.",
      withAttachment: false,
    });
    const elicitationId = "elicitation-queued";
    sql.exec(
      `INSERT INTO elicitation_requests
         (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
          minimum_selections, maximum_selections, target_user_id, status, answer_json,
          answered_by_user_id, external_actor_json, created_at, answered_at)
       VALUES (?, ?, ?, 'Which scope?', 'text', '[]', 0, NULL, NULL,
               'answered', ?, 'user-1', NULL, ?, ?)`,
      elicitationId,
      activated.receiptRunId,
      `${turnId}:tool:0`,
      JSON.stringify("workspace"),
      NOW + 6,
      NOW + 7,
    );
    const answer = await admitPendingInput({
      storage,
      inputId: "00000000-0000-7000-8000-000000000183",
      clientMessageId: `elicitation-response:${elicitationId}`,
      text: "Answered workspace @Ada",
      bindContent: "The person answered workspace.",
      withAttachment: false,
      messageType: "elicitation",
      elicitationId,
    });
    // The run parked on the question, so the loop is idle with both inputs waiting.
    sql.exec(
      `UPDATE substream_loops
          SET status = 'idle', active_execution_id = NULL, active_execution_epoch = NULL,
              lease_owner = NULL, lease_expires_at = NULL, revision = revision + 1
        WHERE id = 1`,
    );
    expect(answer.loop.pendingInputs().map((pending) => pending.input_id))
      .toEqual([queued.inputId, answer.inputId]);

    // The answer closes the withheld call, so it activates ahead of the
    // message queued before it rather than the queue stopping at its head.
    expect(transcript.nextActivationInput("persistent-loop")?.input_id).toBe(answer.inputId);
    const resumed = await transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: answer.inputId,
      expectedLoopRevision: answer.loop.loop()!.revision,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 4,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000184",
        executionEpoch: 1,
        leaseOwner: "queued-owner-2",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: "{}",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: () => undefined,
      now: NOW + 10,
    });
    expect(resumed.transitions.map((transition) => transition.kind))
      .toEqual(["tool_result_accepted"]);
    const projected = bindLoopNonSystemMessages(transcript.readBindProjection("persistent-loop")!);
    expect(JSON.parse(String(projected.at(-1)?.content))).toMatchObject({
      success: true,
      data: { elicitationId, answer: "workspace" },
    });
    // The question is closed and its answer is a canonical turn, so the queued
    // message is what the loop takes next.
    expect(transcript.participantTurn(answer.inputId)).toMatchObject({ turnId: answer.inputId });
    expect(answer.loop.pendingInputs().map((pending) => pending.input_id))
      .toEqual([queued.inputId]);
  });

  it("cancels a withheld question when another message arrives and activates that message", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    const first = await admitPendingInput({ storage, withAttachment: false });
    await transcript.commitBindTransition(initializePersistentLoop(), NOW + 2);
    sql.exec(`UPDATE substream_loops SET bind_state_revision = 1 WHERE id = 1`);
    const activated = await transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: first.inputId,
      expectedLoopRevision: first.loop.loop()!.revision,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 1,
      receipt: {
        substreamId: "0", runId: "00000000-0000-7000-8000-000000000185",
        executionEpoch: 1, leaseOwner: "cancel-owner", leaseExpiresAt: NOW + 100_000,
        executionContextJson: "{}",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message", model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: () => undefined,
      now: NOW + 3,
    });
    const turnId = "persistent-loop:turn:1";
    const reservation = first.loop.reserveAssistantTurn({
      executionId: activated.receiptRunId, executionEpoch: 1,
      leaseOwner: "cancel-owner", expectedLoopRevision: activated.loop.revision,
      receiptRunId: activated.receiptRunId, turnId, modelTurnIndex: 1,
      streamId: "cancel-stream", now: NOW + 4,
    });
    await transcript.commitBindTransition({
      kind: "assistant_reserved", loopId: "persistent-loop", generation: 1,
      stateRevision: 3, turnId, modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
    }, NOW + 5, {
      executionId: activated.receiptRunId, executionEpoch: 1,
      leaseOwner: "cancel-owner", expectedBindStateRevision: 2,
    });
    await transcript.commitBindTransition({
      kind: "assistant_accepted", loopId: "persistent-loop", generation: 1,
      stateRevision: 4, turnId, modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
      message: { role: "assistant", content: null, tool_calls: [{
        id: "provider-cancel-call", type: "function",
        function: { name: "request_elicitation", arguments: "{}" },
      }] },
    }, NOW + 6, {
      executionId: activated.receiptRunId, executionEpoch: 1,
      leaseOwner: "cancel-owner", expectedBindStateRevision: 3,
    });
    sql.exec(
      `INSERT INTO elicitation_requests
         (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
          minimum_selections, maximum_selections, target_user_id, status, answer_json,
          answered_by_user_id, external_actor_json, created_at, answered_at)
       VALUES ('elicitation-cancel', ?, ?, 'Which scope?', 'text', '[]', 0, NULL,
               NULL, 'pending', NULL, NULL, NULL, ?, NULL)`,
      activated.receiptRunId, `${turnId}:tool:0`, NOW + 6,
    );
    const next = await admitPendingInput({
      storage, inputId: "00000000-0000-7000-8000-000000000186",
      clientMessageId: "new-message-cancels-question", text: "Use the latest note @Ada",
      bindContent: "Use the latest note", withAttachment: false,
    });
    expect(sql.exec(`SELECT status FROM elicitation_requests WHERE elicitation_id = 'elicitation-cancel'`).one())
      .toEqual({ status: "cancelled" });
    sql.exec(`UPDATE substream_loops SET status = 'idle', active_execution_id = NULL,
      active_execution_epoch = NULL, lease_owner = NULL, lease_expires_at = NULL,
      revision = revision + 1 WHERE id = 1`);
    expect(transcript.nextActivationInput("persistent-loop")?.input_id).toBe(next.inputId);
    const resumed = await transcript.activatePendingInput({
      loopId: "persistent-loop", expectedInputId: next.inputId,
      expectedLoopRevision: next.loop.loop()!.revision,
      expectedBindGeneration: 1, expectedBindStateRevision: 4,
      receipt: {
        substreamId: "0", runId: "00000000-0000-7000-8000-000000000187",
        executionEpoch: 1, leaseOwner: "cancel-owner-2", leaseExpiresAt: NOW + 100_000,
        executionContextJson: "{}",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message", model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: () => undefined, now: NOW + 10,
    });
    expect(resumed.transitions.map((transition) => transition.kind))
      .toEqual(["tool_result_accepted", "protocol_user_appended"]);
    const messages = bindLoopNonSystemMessages(transcript.readBindProjection("persistent-loop")!);
    expect(JSON.parse(String(messages.at(-2)?.content))).toMatchObject({
      data: { elicitationId: "elicitation-cancel", answer: null, cancelled: true },
    });
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "Use the latest note" });

    // Simulate a queued input written by the old admission path before this
    // cancellation rule existed. Recovery compares durable arrival times.
    await admitPendingInput({
      storage, inputId: "00000000-0000-7000-8000-000000000188",
      clientMessageId: "legacy-queued-after-question", text: "Later note @Ada",
      withAttachment: false,
    });
    sql.exec(
      `INSERT INTO elicitation_requests
         (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
          minimum_selections, maximum_selections, target_user_id, status, answer_json,
          answered_by_user_id, external_actor_json, created_at, answered_at)
       VALUES ('legacy-question', ?, ?, 'Old question', 'text', '[]', 0, NULL,
               NULL, 'pending', NULL, NULL, NULL, ?, NULL)`,
      activated.receiptRunId, `${turnId}:tool:1`, NOW - 1,
    );
    next.loop.cancelPendingElicitations(NOW + 40, true);
    expect(sql.exec(`SELECT status FROM elicitation_requests WHERE elicitation_id = 'legacy-question'`).one())
      .toEqual({ status: "cancelled" });
    sql.exec(
      `INSERT INTO elicitation_requests
         (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
          minimum_selections, maximum_selections, target_user_id, status, answer_json,
          answered_by_user_id, external_actor_json, created_at, answered_at)
       VALUES ('newer-question', ?, ?, 'New question', 'text', '[]', 0, NULL,
               NULL, 'pending', NULL, NULL, NULL, ?, NULL)`,
      activated.receiptRunId, `${turnId}:tool:2`, NOW + 1,
    );
    next.loop.cancelPendingElicitations(NOW + 40, true);
    expect(sql.exec(`SELECT status FROM elicitation_requests WHERE elicitation_id = 'newer-question'`).one())
      .toEqual({ status: "pending" });
    await admitPendingInput({
      storage, actor: "system", messageType: "automation_activation",
      inputId: "00000000-0000-7000-8000-000000000189",
      clientMessageId: "sidekick-message-cancels-question", text: "Sidekick result",
      withAttachment: false,
    });
    expect(sql.exec(`SELECT status FROM elicitation_requests WHERE elicitation_id = 'newer-question'`).one())
      .toEqual({ status: "cancelled" });
  });

  it("settles a cancelled sibling before promoting the only pending answer", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    const first = await admitPendingInput({ storage, withAttachment: false });
    await transcript.commitBindTransition(initializePersistentLoop(), NOW + 2);
    sql.exec(`UPDATE substream_loops SET bind_state_revision = 1 WHERE id = 1`);
    const activated = await transcript.activatePendingInput({
      loopId: "persistent-loop", expectedInputId: first.inputId,
      expectedLoopRevision: first.loop.loop()!.revision,
      expectedBindGeneration: 1, expectedBindStateRevision: 1,
      receipt: {
        substreamId: "0", runId: "00000000-0000-7000-8000-00000000018a",
        executionEpoch: 1, leaseOwner: "sibling-owner", leaseExpiresAt: NOW + 100_000,
        executionContextJson: "{}",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message", model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: () => undefined, now: NOW + 3,
    });
    const turnId = "persistent-loop:turn:1";
    const reservation = first.loop.reserveAssistantTurn({
      executionId: activated.receiptRunId, executionEpoch: 1,
      leaseOwner: "sibling-owner", expectedLoopRevision: activated.loop.revision,
      receiptRunId: activated.receiptRunId, turnId, modelTurnIndex: 1,
      streamId: "sibling-stream", now: NOW + 4,
    });
    await transcript.commitBindTransition({
      kind: "assistant_reserved", loopId: "persistent-loop", generation: 1,
      stateRevision: 3, turnId, modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
    }, NOW + 5, {
      executionId: activated.receiptRunId, executionEpoch: 1,
      leaseOwner: "sibling-owner", expectedBindStateRevision: 2,
    });
    await transcript.commitBindTransition({
      kind: "assistant_accepted", loopId: "persistent-loop", generation: 1,
      stateRevision: 4, turnId, modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
      message: { role: "assistant", content: null, tool_calls: [0, 1].map((index) => ({
        id: `provider-sibling-${index}`, type: "function" as const,
        function: { name: "request_elicitation", arguments: "{}" },
      })) },
    }, NOW + 6, {
      executionId: activated.receiptRunId, executionEpoch: 1,
      leaseOwner: "sibling-owner", expectedBindStateRevision: 3,
    });
    for (const [index, status] of ["answered", "pending"].entries()) {
      sql.exec(
        `INSERT INTO elicitation_requests
           (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
            minimum_selections, maximum_selections, target_user_id, status, answer_json,
            answered_by_user_id, external_actor_json, created_at, answered_at)
         VALUES (?, ?, ?, 'Which scope?', 'text', '[]', 0, NULL,
                 NULL, ?, ?, NULL, NULL, ?, NULL)`,
        `sibling-${index}`, activated.receiptRunId, `${turnId}:tool:${index}`,
        status, index === 0 ? JSON.stringify("a") : null, NOW + 6,
      );
    }
    const answer = await admitPendingInput({
      storage, inputId: "00000000-0000-7000-8000-00000000018b",
      clientMessageId: "sibling-answer", text: "Answered a @Ada",
      withAttachment: false, messageType: "elicitation", elicitationId: "sibling-0",
    });
    answer.loop.cancelPendingElicitations(NOW + 8);
    sql.exec(`UPDATE substream_loops SET status = 'idle', active_execution_id = NULL,
      active_execution_epoch = NULL, lease_owner = NULL, lease_expires_at = NULL,
      revision = revision + 1 WHERE id = 1`);
    expect(transcript.nextActivationInput("persistent-loop")?.input_id).toBe(answer.inputId);
    const resumed = await transcript.activatePendingInput({
      loopId: "persistent-loop", expectedInputId: answer.inputId,
      expectedLoopRevision: answer.loop.loop()!.revision,
      expectedBindGeneration: 1, expectedBindStateRevision: 4,
      receipt: {
        substreamId: "0", runId: "00000000-0000-7000-8000-00000000018c",
        executionEpoch: 1, leaseOwner: "sibling-owner-2", leaseExpiresAt: NOW + 100_000,
        executionContextJson: "{}",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message", model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: () => undefined, now: NOW + 9,
    });
    expect(resumed.transitions.map((transition) => transition.kind))
      .toEqual(["tool_result_accepted", "tool_result_accepted"]);
    const results = bindLoopNonSystemMessages(transcript.readBindProjection("persistent-loop")!)
      .filter((message) => message.role === "tool")
      .map((message) => JSON.parse(String(message.content)).data);
    expect(results).toEqual([
      expect.objectContaining({ elicitationId: "sibling-1", cancelled: true, answer: null }),
      expect.objectContaining({ elicitationId: "sibling-0", answer: "a" }),
    ]);
  });

  it("recovers same-millisecond queued messages by canonical transcript order", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    sql.exec(
      `INSERT INTO runs (run_id, substream_id, status, budget, attempt_epoch,
         model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
         active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
         tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
         created_at, updated_at)
       VALUES ('run-1', '0', 'waiting', '{}', 0, 0, '', 0, 0, ?,
               0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
      NOW, NOW, NOW,
    );
    const question = async (id: string): Promise<void> => {
      await transcript.appendParticipantMessage({
        turnId: `turn-${id}`, clientMessageId: `elicitation:${id}`,
        actor: "assistant", authorUserId: null, authorSnapshot: null,
        messageType: "elicitation", text: "Which scope?",
        createdAtUtc: new Date(NOW + 1).toISOString(), attentionOrdinal: null,
      });
      sql.exec(
        `INSERT INTO elicitation_requests
           (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
            minimum_selections, maximum_selections, target_user_id, status, answer_json,
            answered_by_user_id, external_actor_json, created_at, answered_at)
         VALUES (?, 'run-1', ?, 'Which scope?', 'text', '[]', 0, NULL,
                 NULL, 'pending', NULL, NULL, NULL, ?, NULL)`,
        id, `tool-${id}`, NOW + 1,
      );
    };
    await question("before-input");
    // The old admission path left a question pending when the message arrived.
    sql.exec(`DELETE FROM elicitation_requests WHERE elicitation_id = 'before-input'`);
    await admitPendingInput({ storage, withAttachment: false });
    await question("after-input");
    sql.exec(
      `INSERT INTO elicitation_requests
         (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
          minimum_selections, maximum_selections, target_user_id, status, answer_json,
          answered_by_user_id, external_actor_json, created_at, answered_at)
       VALUES ('before-input', 'run-1', 'tool-before-input', 'Which scope?', 'text', '[]',
               0, NULL, NULL, 'pending', NULL, NULL, NULL, ?, NULL)`,
      NOW + 1,
    );
    new SubstreamLoopStorage(storage).cancelPendingElicitations(NOW + 2, true);
    expect(sql.exec<{ elicitation_id: string; status: string }>(
      `SELECT elicitation_id, status FROM elicitation_requests ORDER BY elicitation_id`,
    ).toArray()).toEqual([
      { elicitation_id: "after-input", status: "pending" },
      { elicitation_id: "before-input", status: "cancelled" },
    ]);
  });

  it("appends a host authority's derived inputs at the settled step, closes them in the same commit, and replays without a second message", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    const first = await admitPendingInput({ storage });
    await transcript.commitBindTransition(initializePersistentLoop(), NOW + 2);
    sql.exec(`UPDATE substream_loops SET bind_state_revision = 1 WHERE id = 1`);
    const activated = await transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: first.inputId,
      expectedLoopRevision: first.loop.loop()!.revision,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 1,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000181",
        executionEpoch: 1,
        leaseOwner: "lease-derived",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: JSON.stringify({ kind: "test_execution", loopId: "persistent-loop" }),
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: "test/model",
      },
      enqueueRegionalEffectsInTransaction: () => undefined,
      now: NOW + 3,
    });
    if (activated.outcome !== "activated") throw new Error("test_activation_failed");
    const assistantTurnId = "persistent-loop:turn:1";
    const reservation = first.loop.reserveAssistantTurn({
      executionId: activated.receiptRunId,
      executionEpoch: 1,
      leaseOwner: "lease-derived",
      expectedLoopRevision: first.loop.loop()!.revision,
      receiptRunId: activated.receiptRunId,
      turnId: assistantTurnId,
      modelTurnIndex: 1,
      streamId: "stream-derived",
      now: NOW + 4,
    });
    if (reservation.outcome !== "reserved") throw new Error("test_reservation_failed");
    const fence = { executionId: activated.receiptRunId, executionEpoch: 1, leaseOwner: "lease-derived" };
    await transcript.commitBindTransition({
      kind: "assistant_reserved", loopId: "persistent-loop", generation: 1, stateRevision: 3,
      turnId: assistantTurnId, modelTurnIndex: 1, transcriptSequence: reservation.reservation.transcript_sequence,
    }, NOW + 5, { ...fence, expectedBindStateRevision: 2 });
    await transcript.commitBindTransition({
      kind: "assistant_accepted", loopId: "persistent-loop", generation: 1, stateRevision: 4,
      turnId: assistantTurnId, modelTurnIndex: 1, transcriptSequence: reservation.reservation.transcript_sequence,
      message: { role: "assistant", content: "Reading the repository" },
    }, NOW + 6, { ...fence, expectedBindStateRevision: 3 });

    const derived = {
      key: "AGENTS.md@abc",
      message: { role: "user", content: "Instructions added from ./AGENTS.md:\nroot rules" },
      provenance: { originKind: "derived" as const, sourceKind: "repository_instructions", sourceId: "AGENTS.md@abc", sourceRevision: null },
    };
    const marked: string[][] = [];
    const settle = (expectedBindStateRevision: number, expectedStepOrdinal: number) => transcript.settlePendingSteersAtStep({
      loopId: "persistent-loop",
      ...fence,
      expectedLoopRevision: first.loop.loop()!.revision,
      expectedStepOrdinal,
      expectedBindGeneration: 1,
      expectedBindStateRevision,
      assistantTurnId,
      modelTurnIndex: 1,
      enqueueRegionalEffectsInTransaction: () => undefined,
      derivedInputs: [derived],
      markDerivedInputsDeliveredInTransaction: (keys) => { marked.push([...keys]); },
      now: NOW + 9,
    });

    const settled = await settle(4, 0);
    expect(settled.transitions).toEqual([expect.objectContaining({
      kind: "protocol_user_appended",
      stateRevision: 5,
      message: derived.message,
      provenance: derived.provenance,
      activationInputId: null,
    })]);
    expect(settled.deliveredDerivedInputKeys).toEqual(["AGENTS.md@abc"]);
    expect(marked).toEqual([["AGENTS.md@abc"]]);
    expect(settled.loop).toMatchObject({ step_ordinal: 1, bind_state_revision: 5 });
    const projected = bindLoopNonSystemMessages(transcript.readBindProjection("persistent-loop")!);
    expect(projected.at(-1)).toEqual(derived.message);
    // The position the summariser is told to skip is the message's own, with the
    // system message at zero, and only for the kinds the ledger owns.
    expect(transcript.bindMessagePositionsBySourceKind("persistent-loop", ["repository_instructions"])).toEqual([projected.length]);
    expect(transcript.bindMessagePositionsBySourceKind("persistent-loop", ["other_kind"])).toEqual([]);
    // Model-only: no participant turn was minted for it.
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE message_type = 'text' AND actor = 'human'`).one())
      .toEqual({ count: 1 });
    expect(sql.exec(
      `SELECT origin_kind, source_kind, source_id FROM transcript_facts WHERE fact_kind = 'model_message' ORDER BY rowid DESC LIMIT 1`,
    ).one()).toEqual({ origin_kind: "derived", source_kind: "repository_instructions", source_id: "AGENTS.md@abc" });

    // The same delivery offered again is a replay: closed, not appended twice.
    const replayed = await settle(5, 1);
    expect(replayed.transitions).toEqual([]);
    expect(replayed.deliveredDerivedInputKeys).toEqual(["AGENTS.md@abc"]);
    expect(bindLoopNonSystemMessages(transcript.readBindProjection("persistent-loop")!).filter((message) => message.content === derived.message.content))
      .toHaveLength(1);
  });

  it("rolls activation back when its synchronous regional-effect enqueue fails", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    const pending = await admitPendingInput({ storage });
    await transcript.commitBindTransition(initializePersistentLoop(), NOW + 2);
    sql.exec(`UPDATE substream_loops SET bind_state_revision = 1 WHERE id = 1`);

    await expect(transcript.activatePendingInput({
      loopId: "persistent-loop",
      expectedInputId: pending.inputId,
      expectedLoopRevision: pending.loop.loop()!.revision,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 1,
      receipt: {
        substreamId: "0",
        runId: "00000000-0000-7000-8000-000000000141",
        executionEpoch: 1,
        leaseOwner: "lease-rollback",
        leaseExpiresAt: NOW + 100_000,
        executionContextJson: "{}",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
        origin: "human_message",
        model: null,
      },
      enqueueRegionalEffectsInTransaction: () => {
        throw new Error("forced_effect_enqueue_failure");
      },
      now: NOW + 3,
    })).rejects.toThrow("forced_effect_enqueue_failure");
    expect(sql.exec(`SELECT input_id FROM pending_loop_inputs WHERE input_id = ?`, pending.inputId).one())
      .toEqual({ input_id: pending.inputId });
    expect(sql.exec(
      `SELECT state FROM pending_loop_input_mailbox WHERE input_id = ?`,
      pending.inputId,
    ).one()).toEqual({ state: "ready" });
    expect(sql.exec(
      `SELECT resource_id FROM pending_attachment_reservation_recovery WHERE input_id = ?`,
      pending.inputId,
    ).one()).toEqual({ resource_id: pending.attachmentId });
    expect(sql.exec(
      `SELECT COUNT(*) AS count FROM delivered_loop_inputs WHERE input_id = ?`,
      pending.inputId,
    ).one()).toEqual({ count: 0 });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns`).one())
      .toEqual({ count: 0 });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM runs`).one()).toEqual({ count: 0 });
    expect(pending.loop.loop()).toMatchObject({ status: "idle", bind_state_revision: 1 });
    expect(transcript.readBindProjection("persistent-loop")?.stateRevision).toBe(1);
  });

  it("seeds development fixtures through canonical order and rejects drift or gaps", async () => {
    const { transcript, sql } = open();
    sql.exec(`INSERT INTO workstream (
      id, workstream_key, parent_workspace_key, region, authority_mode, authority_generation,
      title, description, scope, exact_state, state_reason_code, next_sequence_number,
      next_attention_ordinal, authority_epoch, scope_epoch, source_authorization_floor,
      listing_epoch, deletion_epoch, run_revision, created_at, last_people_activity_at,
      state_changed_at, updated_at
    ) VALUES (1, 'workstream', 'workspace', 'global', 'authoritative', 1, '', '',
      'workspace', 'idle', 'test', 1, 1, 1, 0, 0, 1, 0, 1, ?, ?, ?, ?)`, NOW, NOW, NOW, NOW);
    sql.exec(`INSERT INTO substreams
      (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
      VALUES ('0','main','none',0,'none','workspace','full','open',?)`, NOW);
    const first = {
      turnId: "fixture-human",
      clientMessageId: "fixture-client",
      actor: "human" as const,
      authorUserId: "user-1",
      authorSnapshot: { displayName: "Ada at posting time", avatarUrl: null },
      externalActorJson: null,
      messageType: "text" as const,
      text: "Same visible text",
      structuredContentJson: null,
      producedByRunId: null,
      expectedTranscriptSequence: 1,
      createdAtUtc: new Date(NOW + 10_000).toISOString(),
    };
    expect(await transcript.seedDevelopmentConversationTurn(first)).toEqual({
      outcome: "inserted",
      transcriptSequence: 1,
    });
    expect(await transcript.seedDevelopmentConversationTurn({
      turnId: "fixture-tool",
      clientMessageId: null,
      actor: "assistant",
      authorUserId: null,
      authorSnapshot: null,
      externalActorJson: null,
      messageType: "tool",
      text: "",
      structuredContentJson: JSON.stringify({
        invocation: { toolCallId: "tool-call-1", toolName: "search", status: "completed" },
      }),
      producedByRunId: null,
      expectedTranscriptSequence: 2,
      // Timestamp order is deliberately opposite canonical order.
      createdAtUtc: new Date(NOW).toISOString(),
    })).toEqual({ outcome: "inserted", transcriptSequence: 2 });

    const snapshot = transcript.createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null, now: NOW });
    expect(snapshot.ranges.flatMap((range) => range.turns).map((turn) => turn.turnId))
      .toEqual(["fixture-human", "fixture-tool"]);
    expect(snapshot.ranges.flatMap((range) => range.turns)[0]!.authorSnapshot).toEqual({
      userId: "user-1",
      displayName: "Ada at posting time",
      avatarUrl: null,
    });
    expect(snapshot.ranges.flatMap((range) => range.turns)[1]!.blocks[0]).toMatchObject({
      type: "tool",
      toolCallId: "tool-call-1",
      status: "completed",
    });
    await expect(transcript.seedDevelopmentConversationTurn(first)).resolves.toEqual({
      outcome: "replayed",
      transcriptSequence: 1,
    });
    await expect(transcript.seedDevelopmentConversationTurn({ ...first, text: "drifted" }))
      .rejects.toThrow("development_turn_replay_conflict");
    await expect(transcript.seedDevelopmentConversationTurn({
      ...first,
      authorSnapshot: { displayName: "Mutable profile drift", avatarUrl: null },
    })).rejects.toThrow("development_turn_replay_conflict");
    await expect(transcript.seedDevelopmentConversationTurn({
      ...first,
      turnId: "fixture-gap",
      clientMessageId: "fixture-gap",
      expectedTranscriptSequence: 4,
    })).rejects.toThrow("development_turn_sequence_mismatch");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns`).one())
      .toEqual({ count: 2 });
  });

  it("rejects development turns that could not cross the canonical provenance contract", async () => {
    const { transcript } = open();
    await expect(transcript.seedDevelopmentConversationTurn({
      turnId: "fixture-invalid-human",
      clientMessageId: "fixture-invalid-human",
      actor: "human",
      authorUserId: "user-1",
      authorSnapshot: null,
      externalActorJson: null,
      messageType: "text",
      text: "Missing immutable identity",
      structuredContentJson: null,
      producedByRunId: null,
      expectedTranscriptSequence: 1,
      createdAtUtc: new Date(NOW).toISOString(),
    })).rejects.toThrow("development_turn_author_snapshot_required");
    await expect(transcript.seedDevelopmentConversationTurn({
      turnId: "fixture-invalid-system",
      clientMessageId: null,
      actor: "system",
      authorUserId: "user-1",
      authorSnapshot: { displayName: "Not a system author", avatarUrl: null },
      externalActorJson: null,
      messageType: "system",
      text: "Impossible provenance",
      structuredContentJson: null,
      producedByRunId: null,
      expectedTranscriptSequence: 1,
      createdAtUtc: new Date(NOW).toISOString(),
    })).rejects.toThrow("development_turn_author_snapshot_invalid");
  });

  it("stores assistant text and tool plans once while both projections reference canonical facts", async () => {
    const { transcript, sql, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Before tools", toolCount: 2, now: NOW + 1,
    });
    await transcript.commitBindTransition(reserved.transition, NOW + 2, reserved.executionFence);

    const snapshot = transcript.createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null, now: NOW + 2 });
    const turn = snapshot.ranges[0]!.turns[0]!;
    expect(turn.blocks.map((block) => block.type)).toEqual(["text", "tool", "tool"]);
    expect(turn.blocks.filter((block) => block.type === "tool").map((block) => block.callIndex))
      .toEqual([0, 1]);

    const assistantFactId = String(sql.exec<{ fact_id: string } & Record<string, SqlStorageValue>>(
      `SELECT fact_id FROM bind_loop_state_messages
        WHERE loop_id = 'run-1' AND message_position = 2`,
    ).one().fact_id);
    expect(sql.exec<{ root_fact_id: string } & Record<string, SqlStorageValue>>(
      `SELECT root_fact_id FROM participant_transcript_turns WHERE turn_id = 'run-1:turn:1'`,
    ).one().root_fact_id).toBe(assistantFactId);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM transcript_payloads
      WHERE payload_json LIKE '%Before tools%'`).one().count).toBe(1);
  });

  it("promotes active participant links in assistant prose into authoritative mentions", async () => {
    const activeUserId = "00000000-0000-7000-8000-0000000000a1";
    const removedUserId = "00000000-0000-7000-8000-0000000000a2";
    const activeLink = `[@Alex](person://${activeUserId})`;
    const removedLink = `[@Former member](person://${removedUserId})`;
    const content = `Please ask ${activeLink}. Ignore ${removedLink}.`;
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    sql.exec(
      `INSERT INTO participants
         (user_id, participation_reason, added_by_user_id, status, participant_epoch,
          added_at, removed_at, first_opened_at, updated_at)
       VALUES (?, 'explicit', 'user-1', 'active', 0, ?, NULL, NULL, ?),
              (?, 'explicit', 'user-1', 'removed', 1, ?, ?, NULL, ?)`,
      activeUserId,
      NOW,
      NOW,
      removedUserId,
      NOW,
      NOW + 1,
      NOW + 1,
    );
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content, now: NOW + 1,
    });
    await expect(transcript.commitBindTransition(
      reserved.transition,
      NOW + 2,
      reserved.executionFence,
    )).rejects.toThrow("assistant_mention_effect_enqueue_required");
    expect(transcript.participantTurn("run-1:turn:1")).toBeNull();
    expect(transcript.readBindProjection("run-1")!.stateRevision).toBe(2);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM member_attention`).one()).toEqual({ count: 0 });

    const deliveries: PendingInputDeliveryEffectInput[] = [];
    await transcript.commitBindTransition(
      reserved.transition,
      NOW + 2,
      reserved.executionFence,
      (effects) => deliveries.push(...effects),
    );

    expect(transcript.participantTurn("run-1:turn:1")).toMatchObject({
      attentionOrdinal: 1,
      blocks: [expect.objectContaining({
        mentions: [expect.objectContaining({
          type: "person",
          userId: activeUserId,
          startOffset: content.indexOf(activeLink),
          endOffset: content.indexOf(activeLink) + activeLink.length,
        })],
      })],
    });
    expect(deliveries).toEqual([expect.objectContaining({
      actor: "assistant",
      authorUserId: null,
      mentionedUserIds: [activeUserId],
      affectedUserIds: [activeUserId],
    })]);
    expect(sql.exec(
      `SELECT latest_mention_attention_ordinal FROM member_attention WHERE user_id = ?`,
      activeUserId,
    ).one()).toEqual({ latest_mention_attention_ordinal: 1 });
    expect(sql.exec(`SELECT next_attention_ordinal FROM workstream WHERE id = 1`).one())
      .toEqual({ next_attention_ordinal: 2 });
  });

  it("repairs a host reservation whose Bind edge did not commit before settling failure", async () => {
    const { transcript, sql, storage } = open();
    seedPendingInputRoot(sql);
    await transcript.commitBindTransition(initialize(), NOW);
    const executionId = "00000000-0000-7000-8000-0000000000f2";
    const leaseOwner = "reservation-repair-owner";
    const runs = new WorkstreamHarnessRunStorage(storage);
    expect(runs.admitRun({
      runId: executionId,
      origin: "member_message",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: "user-1" }),
      status: "running",
      startedAt: NOW,
      model: "test/model",
      triggerPartId: null,
      parentRunId: null,
      expectedLatestRunId: null,
      now: NOW,
    })).toEqual({ outcome: "admitted" });
    sql.exec(
      `UPDATE runs SET execution_context_json = '{"kind":"test_execution"}' WHERE run_id = ?`,
      executionId,
    );
    const loop = new SubstreamLoopStorage(storage);
    loop.ensureLoop({ loopId: "run-1", bindStateRevision: 1, now: NOW });
    loop.activateExecutionReceipt({
      runId: executionId,
      loopId: "run-1",
      executionEpoch: 1,
      leaseOwner,
      leaseExpiresAt: NOW + 60_000,
      expectedLoopRevision: loop.loop()!.revision,
      expectedBindStateRevision: 1,
      now: NOW,
    });
    const reserved = loop.reserveAssistantTurn({
      executionId,
      executionEpoch: 1,
      leaseOwner,
      expectedLoopRevision: loop.loop()!.revision,
      receiptRunId: executionId,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      streamId: "reservation-repair-stream",
      now: NOW + 1,
    });
    if (reserved.outcome !== "reserved") throw new Error("test_assistant_turn_not_reserved");
    expect(transcript.readBindProjection("run-1")).toMatchObject({
      stateRevision: 1,
      lastModelTurnIndex: 0,
      lastAssistantReservation: null,
    });

    await expect(transcript.settleActiveAssistantReservation({
      loopId: "run-1",
      executionId,
      executionEpoch: 1,
      leaseOwner,
      outcome: "failed",
      code: "run_state_persistence_failed",
      label: "Response could not be completed",
      now: NOW + 2,
    })).resolves.toEqual({
      turnId: "run-1:turn:1",
      transcriptSequence: reserved.reservation.transcript_sequence,
    });
    expect(transcript.readBindProjection("run-1")).toMatchObject({
      stateRevision: 3,
      lastModelTurnIndex: 1,
      lastAssistantReservation: {
        turnId: "run-1:turn:1",
        status: "failed",
        transcriptSequence: reserved.reservation.transcript_sequence,
      },
    });
    expect(loop.reservation("run-1:turn:1")).toMatchObject({
      state: "materialized",
      outcome: "error",
    });
    expect(loop.loop()).toMatchObject({ bind_state_revision: 3 });
    expect(transcript.participantTurn("run-1:turn:1")).toMatchObject({
      transcriptSequence: reserved.reservation.transcript_sequence,
      actor: "system",
      blocks: [expect.objectContaining({ text: "Response could not be completed" })],
    });
    const realtimePayload = JSON.parse(sql.exec<{
      payload_json: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT payload_json FROM durable_outbox
        WHERE channel = 'semantic_realtime_v1'
        ORDER BY source_version DESC LIMIT 1`,
    ).one().payload_json) as { reference: unknown };
    expect(realtimePayload.reference).toEqual({
      kind: "transcript_turn",
      turnId: "run-1:turn:1",
    });
  });

  it("stores typed provenance for exact model-facing derivatives without copying participant ownership", async () => {
    const { transcript, sql, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Answer", toolCount: 1, now: NOW + 1,
    });
    await transcript.commitBindTransition(reserved.transition, NOW + 2, reserved.executionFence);
    await transcript.commitBindTransition({
      kind: "tool_result_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 4,
      turnId: "run-1:turn:1",
      toolCallId: "provider-1-0",
      callIndex: 0,
      resultOrdinal: 0,
      message: { role: "tool", tool_call_id: "provider-1-0", content: "{\"ok\":true}" },
    }, NOW + 3, {
      ...reserved.executionFence,
      expectedBindStateRevision: 3,
    });

    const rows = sql.exec<{
      fact_kind: string;
      origin_kind: string;
      source_kind: string | null;
      source_id: string | null;
      source_revision: number | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT fact.fact_kind, fact.origin_kind, fact.source_kind, fact.source_id,
              fact.source_revision
         FROM bind_loop_state_messages projected
         JOIN transcript_facts fact ON fact.fact_id = projected.fact_id
        WHERE projected.loop_id = 'run-1'
        ORDER BY projected.message_position`,
    ).toArray();

    expect(rows).toEqual([
      expect.objectContaining({
        fact_kind: "system_projection",
        origin_kind: "system_projection",
        source_kind: "system_prompt_inputs",
        source_id: "input-1",
        source_revision: 1,
      }),
      expect.objectContaining({
        fact_kind: "model_message",
        origin_kind: "derived",
        source_kind: "participant_turn",
        source_id: "message-1",
        source_revision: 1,
      }),
      expect.objectContaining({
        fact_kind: "model_message",
        origin_kind: "canonical",
        source_kind: null,
        source_id: null,
        source_revision: null,
      }),
      expect.objectContaining({
        fact_kind: "model_message",
        origin_kind: "derived",
        source_kind: "tool_receipt",
        source_id: "run-1:turn:1:tool:0",
        source_revision: 0,
      }),
    ]);
  });

  it("recovers missing and ambiguous tool results without reordering accepted siblings or leaving activities active", async () => {
    const { transcript, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Checking all", toolCount: 3, now: NOW + 1,
    });
    await transcript.commitBindTransition(reserved.transition, NOW + 2, reserved.executionFence);
    const executionId = reserved.executionFence.executionId;
    for (const edge of [
      {
        activityId: `${executionId}:activity`, parentActivityId: null,
        scope: "response" as const, subjectId: executionId, callIndex: null,
        label: "Working", action: "start" as const, revision: 1,
      },
      {
        activityId: "run-1:turn:1:activity", parentActivityId: `${executionId}:activity`,
        scope: "assistant_turn" as const, subjectId: "run-1:turn:1", callIndex: 1,
        label: "Assistant turn", action: "start" as const, revision: 1,
      },
      {
        activityId: "run-1:turn:1:tool:0:activity", parentActivityId: "run-1:turn:1:activity",
        scope: "tool_call" as const, subjectId: "run-1:turn:1:tool:0", callIndex: 0,
        label: "tool-0", action: "start" as const, revision: 1,
      },
      {
        activityId: "run-1:turn:1:tool:1:activity", parentActivityId: "run-1:turn:1:activity",
        scope: "tool_call" as const, subjectId: "run-1:turn:1:tool:1", callIndex: 1,
        label: "tool-1", action: "start" as const, revision: 1,
      },
      {
        activityId: "run-1:turn:1:tool:2:activity", parentActivityId: "run-1:turn:1:activity",
        scope: "tool_call" as const, subjectId: "run-1:turn:1:tool:2", callIndex: 2,
        label: "tool-2", action: "start" as const, revision: 1,
      },
    ]) {
      transcript.upsertActivity({
        ...edge,
        occurredAtUtc: new Date(NOW + 2).toISOString(),
      });
    }
    await transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:1",
      pluginId: null,
      toolName: "tool-1",
      status: "completed",
      participantSafeResult: "second completed",
      occurredAtUtc: new Date(NOW + 3).toISOString(),
    });
    await transcript.commitBindTransition({
      kind: "tool_result_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 4,
      turnId: "run-1:turn:1",
      toolCallId: "provider-1-1",
      callIndex: 1,
      resultOrdinal: 0,
      message: { role: "tool", tool_call_id: "provider-1-1", content: "second" },
    }, NOW + 3, {
      ...reserved.executionFence,
      expectedBindStateRevision: 3,
    });

    await transcript.commitRecoveredToolResult({
      transition: {
        kind: "tool_result_accepted",
        loopId: "run-1",
        generation: 1,
        stateRevision: 5,
        turnId: "run-1:turn:1",
        toolCallId: "provider-1-0",
        callIndex: 0,
        resultOrdinal: 1,
        recoverySource: "not_run",
        message: {
          role: "tool",
          tool_call_id: "provider-1-0",
          content: JSON.stringify({
            success: false,
            kind: "external",
            error: "tool_not_run_after_interruption",
            data: { recovery: "not_run" },
          }),
        },
      },
      receiptToolCallId: "run-1:turn:1:tool:0",
      lifecycle: {
        toolName: "tool-0",
        status: "failed",
        participantSafeResult: "Rally did not run this tool after recovery",
        error: "Rally did not run this tool after recovery",
      },
      settlesBatch: false,
      executionFence: {
        ...reserved.executionFence,
        expectedBindStateRevision: 4,
      },
      now: NOW + 4,
    });

    await transcript.commitRecoveredToolResult({
      transition: {
        kind: "tool_result_accepted",
        loopId: "run-1",
        generation: 1,
        stateRevision: 6,
        turnId: "run-1:turn:1",
        toolCallId: "provider-1-2",
        callIndex: 2,
        resultOrdinal: 2,
        recoverySource: "tool_receipt",
        message: {
          role: "tool",
          tool_call_id: "provider-1-2",
          content: JSON.stringify({
            success: false,
            kind: "ambiguous_external_write",
            error: "ambiguous_external_write",
          }),
        },
      },
      receiptToolCallId: "run-1:turn:1:tool:2",
      lifecycle: {
        toolName: "tool-2",
        status: "ambiguous",
        participantSafeResult: "Rally could not confirm whether this external action completed",
        error: "Rally could not confirm whether this external action completed",
      },
      settlesBatch: true,
      executionFence: {
        ...reserved.executionFence,
        expectedBindStateRevision: 5,
      },
      now: NOW + 5,
    });

    expect(bindLoopNonSystemMessages(transcript.readBindProjection("run-1")!)
      .slice(-3).map((message) => message.tool_call_id))
      .toEqual(["provider-1-1", "provider-1-0", "provider-1-2"]);
    expect((storage.sql.exec(
      `SELECT source_kind FROM transcript_facts
        WHERE fact_id = 'run-1:state:5:tool_result_accepted'`,
    ).one() as { source_kind: string }).source_kind).toBe("tool_recovery_not_run");
    const tools = transcript.participantTurn("run-1:turn:1")!.blocks
      .filter((block) => block.type === "tool");
    expect(tools.map((tool) => [tool.callIndex, tool.status])).toEqual([
      [0, "failed"],
      [1, "completed"],
      [2, "ambiguous"],
    ]);
    const recoveredActivities = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 6,
    }).activities.filter((activity) => activity.activityId.startsWith("run-1:turn:1"));
    expect(recoveredActivities.map((activity) => [activity.activityId, activity.state]))
      .toEqual([
        ["run-1:turn:1:activity", "ambiguous"],
        ["run-1:turn:1:tool:0:activity", "failed"],
        ["run-1:turn:1:tool:1:activity", "completed"],
        ["run-1:turn:1:tool:2:activity", "ambiguous"],
      ]);
    expect(recoveredActivities.flatMap((activity) => activity.intervals)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stoppedAtUtc: new Date(NOW + 5).toISOString(),
          boundarySource: "recovered",
          timingAccuracy: "upper_bound",
        }),
      ]),
    );
  });

  it("rejects derivative facts without a durable source identity", () => {
    const { database } = open();
    database.prepare(
      `INSERT INTO transcript_payloads
         (payload_id, audience, media_type, payload_json, payload_sha256, byte_length, created_at)
       VALUES ('payload-test', 'model', 'application/json', '{}', 'hash', 2, ?)`,
    ).run(NOW);
    expect(() => database.prepare(
      `INSERT INTO transcript_facts
         (fact_id, fact_kind, payload_id, origin_kind, source_kind, source_id,
          source_revision, run_id, turn_id, tool_call_id, created_at)
       VALUES ('fact-test', 'model_message', 'payload-test', 'derived', NULL, NULL,
               NULL, 'run-1', NULL, NULL, ?)`,
    ).run(NOW)).toThrow(/CHECK constraint failed/u);
  });

  it("keeps parallel tool lifecycle updates in declared call order regardless of settle order", async () => {
    const { transcript, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Checking", toolCount: 2, now: NOW + 1,
    });
    await transcript.commitBindTransition(reserved.transition, NOW + 2, reserved.executionFence);
    await transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:1",
      pluginId: "github",
      toolName: "tool-1",
      status: "completed",
      participantSafeResult: { value: "second settled first" },
      error: null,
      occurredAtUtc: new Date(NOW + 4).toISOString(),
    });
    await transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "failed",
      error: "first settled second",
      occurredAtUtc: new Date(NOW + 5).toISOString(),
    });

    const turn = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 6,
    }).ranges[0]!.turns[0]!;
    const tools = turn.blocks.filter((block) => block.type === "tool");
    expect(tools.map((block) => [block.callIndex, block.status])).toEqual([
      [0, "failed"],
      [1, "completed"],
    ]);
  });

  it("retains participant-safe tool input when a terminal lifecycle fact replaces started", async () => {
    const { transcript, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Checking", toolCount: 1, now: NOW + 1,
    });
    await transcript.commitBindTransition(reserved.transition, NOW + 2, reserved.executionFence);
    await transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "started",
      participantSafeInput: { query: "open pull requests" },
      occurredAtUtc: new Date(NOW + 2).toISOString(),
    });
    await transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "completed",
      participantSafeResult: "Found two",
      occurredAtUtc: new Date(NOW + 3).toISOString(),
    });

    const tool = transcript.participantTurn("run-1:turn:1")?.blocks
      .find((block) => block.type === "tool");
    expect(tool).toMatchObject({
      status: "completed",
      participantSafeInput: { query: "open pull requests" },
      participantSafeResult: "Found two",
    });
  });

  it("rejects a prepared tool settlement after another lifecycle update wins", async () => {
    const { transcript, sql, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Checking", toolCount: 1, now: NOW + 1,
    });
    await transcript.commitBindTransition(reserved.transition, NOW + 2, reserved.executionFence);
    const staleCompletion = await transcript.prepareToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "completed",
      participantSafeResult: "stale result",
      occurredAtUtc: new Date(NOW + 3).toISOString(),
    });

    await transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "started",
      participantSafeInput: { query: "new authority" },
      occurredAtUtc: new Date(NOW + 2).toISOString(),
    });

    expect(() => transcript.upsertPreparedToolLifecycle(staleCompletion))
      .toThrow("participant_tool_lifecycle_source_moved");
    expect(sql.exec<{ lifecycle_state: string } & Record<string, SqlStorageValue>>(
      `SELECT lifecycle_state FROM participant_transcript_blocks
        WHERE tool_call_id = 'run-1:turn:1:tool:0'`,
    ).one()).toEqual({ lifecycle_state: "started" });
    expect(sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM transcript_facts
        WHERE fact_id = 'run-1:turn:1:tool:0:participant:completed'`,
    ).one().count).toBe(0);
  });

  it("does not rewrite one terminal tool outcome as a different terminal fact", async () => {
    const { transcript, sql, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Checking", toolCount: 1, now: NOW + 1,
    });
    await transcript.commitBindTransition(reserved.transition, NOW + 2, reserved.executionFence);
    await transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "completed",
      participantSafeResult: "done",
      occurredAtUtc: new Date(NOW + 2).toISOString(),
    });

    await expect(transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "failed",
      error: "late conflicting settlement",
      occurredAtUtc: new Date(NOW + 3).toISOString(),
    })).rejects.toThrow("participant_tool_lifecycle_terminal_conflict");
    expect(sql.exec<{ lifecycle_state: string } & Record<string, SqlStorageValue>>(
      `SELECT lifecycle_state FROM participant_transcript_blocks
        WHERE tool_call_id = 'run-1:turn:1:tool:0'`,
    ).one()).toEqual({ lifecycle_state: "completed" });
    expect(sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM transcript_facts
        WHERE fact_id = 'run-1:turn:1:tool:0:participant:failed'`,
    ).one().count).toBe(0);
  });

  it("rejects an invalid tool lifecycle timestamp before writing a fact", async () => {
    const { transcript, sql, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Checking", toolCount: 1, now: NOW + 1,
    });
    await transcript.commitBindTransition(reserved.transition, NOW + 2, reserved.executionFence);

    await expect(transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "started",
      occurredAtUtc: "not-a-timestamp",
    })).rejects.toThrow("invalid_tool_lifecycle_timestamp");
    expect(sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM transcript_facts
        WHERE fact_id = 'run-1:turn:1:tool:0:participant:started'`,
    ).one().count).toBe(0);
  });

  it("rejects non-JSON array values instead of hashing them as null", async () => {
    const { transcript, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Checking", toolCount: 1, now: NOW + 1,
    });
    await transcript.commitBindTransition(reserved.transition, NOW + 2, reserved.executionFence);

    await expect(transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "started",
      participantSafeInput: [undefined],
      occurredAtUtc: new Date(NOW + 2).toISOString(),
    })).rejects.toThrow("transcript_non_json_value");
  });

  it("never exposes provider reasoning content in a participant thinking block", async () => {
    const { transcript, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    transcript.upsertActivity({
      activityId: "run-1:turn:1:activity",
      parentActivityId: null,
      scope: "assistant_turn",
      subjectId: "run-1:turn:1",
      callIndex: 0,
      label: "Working",
      action: "start",
      revision: 1,
      occurredAtUtc: new Date(NOW).toISOString(),
    });
    transcript.upsertActivity({
      activityId: "run-1:turn:1:thinking",
      parentActivityId: "run-1:turn:1:activity",
      scope: "thinking",
      subjectId: "run-1:turn:1",
      callIndex: null,
      label: "Thinking",
      action: "complete",
      revision: 1,
      occurredAtUtc: new Date(NOW + 1).toISOString(),
    });
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Answer", now: NOW + 2,
    });
    reserved.transition.message = {
      ...reserved.transition.message,
      summary: "private provider reasoning",
    } as typeof reserved.transition.message;
    await transcript.commitBindTransition(
      reserved.transition,
      NOW + 3,
      reserved.executionFence,
    );

    const thinking = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 3,
    }).ranges[0]!.turns[0]!.blocks.find((block) => block.type === "thinking");
    expect(thinking).toMatchObject({ type: "thinking", summary: null });
    expect(JSON.stringify(thinking)).not.toContain("private provider reasoning");
  });

  it("hydrates only range-owned activities and active ancestry in one bounded snapshot", async () => {
    const { transcript, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const rootId = "run-1:activity";
    const turnId = "run-1:turn:1";
    const assistantId = `${turnId}:activity`;
    const pluginId = `${turnId}:plugin:github`;
    const toolId = `${turnId}:tool:0:activity`;
    transcript.upsertActivity({
      activityId: rootId, parentActivityId: null, scope: "response", subjectId: "run-1",
      callIndex: null, label: "Working", action: "start", revision: 1,
      occurredAtUtc: new Date(NOW).toISOString(),
    });
    transcript.upsertActivity({
      activityId: assistantId, parentActivityId: rootId, scope: "assistant_turn", subjectId: turnId,
      callIndex: 1, label: "Assistant turn", action: "start", revision: 1,
      occurredAtUtc: new Date(NOW + 1).toISOString(),
    });
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Checking", toolCount: 1, now: NOW + 2,
    });
    await transcript.commitBindTransition(reserved.transition, NOW + 3, reserved.executionFence);
    transcript.upsertActivity({
      activityId: pluginId, parentActivityId: assistantId, scope: "plugin", subjectId: "github",
      callIndex: 0, label: "GitHub", connectorType: "custom_mcp", action: "start", revision: 1,
      occurredAtUtc: new Date(NOW + 3).toISOString(),
    });
    await transcript.upsertToolLifecycle({
      toolCallId: `${turnId}:tool:0`, pluginId: "github", toolName: "tool-0", status: "started",
      participantSafeInput: { query: "one" }, occurredAtUtc: new Date(NOW + 3).toISOString(),
    });
    transcript.upsertActivity({
      activityId: toolId, parentActivityId: pluginId, scope: "tool_call", subjectId: `${turnId}:tool:0`,
      callIndex: 0, label: "Search", action: "start", revision: 1,
      occurredAtUtc: new Date(NOW + 3).toISOString(),
    });
    transcript.upsertActivity({
      activityId: toolId, parentActivityId: pluginId, scope: "tool_call", subjectId: `${turnId}:tool:0`,
      callIndex: 0, label: "Search", action: "complete", revision: 2,
      occurredAtUtc: new Date(NOW + 4).toISOString(),
    });
    for (const [activityId, parentActivityId, scope, subjectId] of [
      [pluginId, assistantId, "plugin", "github"],
      [assistantId, rootId, "assistant_turn", turnId],
      [rootId, null, "response", "run-1"],
    ] as const) {
      transcript.upsertActivity({
        activityId, parentActivityId, scope, subjectId, callIndex: null,
        label: subjectId, action: "complete", revision: 2,
        occurredAtUtc: new Date(NOW + 5).toISOString(),
      });
    }
    for (let index = 0; index < 25; index += 1) {
      transcript.upsertActivity({
        activityId: `historical:${index}`, parentActivityId: null, scope: "response",
        subjectId: `historical:${index}`, callIndex: null, label: "Historical",
        action: "complete", revision: 1, occurredAtUtc: new Date(NOW - index - 1).toISOString(),
      });
    }

    const snapshot = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 6,
    });
    expect(snapshot.activities.map((activity) => activity.activityId)).toEqual([
      rootId,
      assistantId,
      pluginId,
      toolId,
    ]);
    expect(snapshot.activities.find((activity) => activity.activityId === pluginId)?.connectorType).toBe("custom_mcp");
    expect(snapshot.pluginRuns.find((run) => run.pluginRunId === pluginId)?.connectorType).toBe("custom_mcp");
    expect(transcript.transcriptActivity(pluginId)?.connectorType).toBe("custom_mcp");
    const loaded = transcript.range(snapshot, { startInclusive: 1, endExclusive: 2 });
    expect(loaded.pluginRuns.find((run) => run.pluginRunId === pluginId)?.connectorType).toBe("custom_mcp");
    expect(loaded.activities.map((activity) => activity.activityId)).toEqual([
      rootId,
      assistantId,
      pluginId,
      toolId,
    ]);
  });

  it("returns unread-centered and latest ranges from one immutable snapshot fence and exposes gaps", async () => {
    const { transcript, sql } = open();
    sql.exec(`INSERT INTO substreams
      (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
      VALUES ('0','main','none',0,'none','workspace','full','open',1)`);
    for (let index = 1; index <= 30; index += 1) {
      await transcript.appendParticipantMessage({
        turnId: `message-${index}`,
        actor: "human",
        authorUserId: "user-1",
        authorSnapshot: { displayName: "Alex at posting time", avatarUrl: null },
        text: index <= 25 ? "x".repeat(200_000) : `Message ${index}`,
        createdAtUtc: new Date(NOW + index).toISOString(),
        attentionOrdinal: index,
      });
    }

    const snapshot = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: 10,
      now: NOW + 100,
    });
    expect(snapshot.snapshotThrough).toBe(30);
    expect(snapshot.unreadAnchorSequence).toBe(10);
    expect(snapshot.unreadReason).toBeNull();
    expect(snapshot.ranges.map((range) => range.purpose)).toEqual(["unread", "latest"]);
    expect(snapshot.ranges).toHaveLength(2);
    expect(snapshot.ranges.map((range) => range.turns.map((turn) => turn.transcriptSequence)))
      .toEqual([
        [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        [22, 23, 24, 25, 26, 27, 28, 29, 30],
      ]);

    const gap = transcript.range(snapshot, { startInclusive: 17, endExclusive: 22 });
    expect(gap.covered).toEqual({ startInclusive: 17, endExclusive: 22 });
    expect(gap.turns).toHaveLength(5);
    await transcript.appendParticipantMessage({
      turnId: "message-after-fence",
      actor: "human",
      authorUserId: "user-1",
      authorSnapshot: { displayName: "Alex at posting time", avatarUrl: null },
      text: "Not in old snapshot",
      createdAtUtc: new Date(NOW + 101).toISOString(),
      attentionOrdinal: 31,
    });
    expect(transcript.range(snapshot, { startInclusive: 30, endExclusive: 40 }).covered)
      .toEqual({ startInclusive: 30, endExclusive: 31 });
  });

  it("persists immutable human authorship and rejects anonymous forward-path turns", async () => {
    const { transcript } = open();
    await transcript.appendParticipantMessage({
      turnId: "authored-message",
      actor: "human",
      authorUserId: "user-removed-later",
      authorSnapshot: {
        displayName: "Alex at posting time",
        avatarUrl: "https://example.com/avatar.png",
      },
      text: "Historical authorship survives membership changes.",
      createdAtUtc: new Date(NOW).toISOString(),
      attentionOrdinal: 1,
    });

    expect(transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 1,
    }).ranges[0]!.turns[0]!.authorSnapshot).toEqual({
      userId: "user-removed-later",
      displayName: "Alex at posting time",
      avatarUrl: "https://example.com/avatar.png",
    });
    await expect(transcript.appendParticipantMessage({
      turnId: "anonymous-human",
      actor: "human",
      authorUserId: "user-1",
      authorSnapshot: null,
      text: "Missing immutable identity",
      createdAtUtc: new Date(NOW + 2).toISOString(),
      attentionOrdinal: 2,
    })).rejects.toThrow("participant_message_author_snapshot_required");
  });

  it("normalizes author snapshots before storage so every persisted row satisfies the read contract", async () => {
    const { transcript } = open();
    await transcript.appendParticipantMessage({
      turnId: "normalized-author-message",
      actor: "human",
      authorUserId: "user-1",
      authorSnapshot: {
        displayName: "a".repeat(181),
        avatarUrl: "not an HTTP URL",
      },
      text: "The profile source exceeded the transcript contract.",
      createdAtUtc: new Date(NOW).toISOString(),
      attentionOrdinal: 1,
    });

    expect(transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 1,
    }).ranges[0]!.turns[0]!.authorSnapshot).toEqual({
      userId: "user-1",
      displayName: "a".repeat(180),
      avatarUrl: null,
    });
  });

  it("hydrates reconnect-safe nested activity intervals from server UTC and snapshot baselines", () => {
    const { transcript } = open();
    transcript.upsertActivity({
      activityId: "run-1:activity",
      parentActivityId: null,
      scope: "response",
      subjectId: "run-1",
      callIndex: null,
      label: "Working",
      action: "start",
      revision: 1,
      occurredAtUtc: new Date(NOW).toISOString(),
    });
    transcript.upsertActivity({
      activityId: "plugin:github",
      parentActivityId: "run-1:activity",
      scope: "plugin",
      subjectId: "github",
      callIndex: 0,
      label: "GitHub working",
      action: "start",
      revision: 1,
      occurredAtUtc: new Date(NOW + 1_000).toISOString(),
    });
    transcript.upsertActivity({
      activityId: "tool:1",
      parentActivityId: "plugin:github",
      scope: "tool_call",
      subjectId: "tool:1",
      callIndex: 0,
      label: "Search",
      action: "start",
      revision: 1,
      occurredAtUtc: new Date(NOW + 2_000).toISOString(),
    });

    const snapshot = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 7_000,
    });
    expect(snapshot.activeActivities.map((activity) => activity.activityId))
      .toEqual(["run-1:activity", "plugin:github", "tool:1"]);
    expect(snapshot.activeActivities.map((activity) => activity.intervals[0]!.elapsedMsAtSnapshot))
      .toEqual([7_000, 6_000, 5_000]);

    const completed = transcript.upsertActivity({
      activityId: "tool:1",
      parentActivityId: "plugin:github",
      scope: "tool_call",
      subjectId: "tool:1",
      callIndex: 0,
      label: "Search",
      action: "complete",
      revision: 2,
      occurredAtUtc: new Date(NOW + 8_000).toISOString(),
    });
    expect(completed.state).toBe("completed");
    expect(completed.intervals[0]).toMatchObject({ durationMs: 6_000, elapsedMsAtSnapshot: null });
  });

  it("pauses and resumes one response as separate intervals without counting the gap", () => {
    const { transcript } = open();
    const edge = {
      activityId: "run-paused",
      parentActivityId: null,
      scope: "response" as const,
      subjectId: "run-paused",
      callIndex: null,
      label: "Working",
    };
    transcript.upsertActivity({
      ...edge, action: "start", revision: 1,
      occurredAtUtc: new Date(NOW).toISOString(),
    });
    transcript.upsertActivity({
      ...edge, action: "complete", revision: 2,
      occurredAtUtc: new Date(NOW + 2_000).toISOString(),
    });
    transcript.upsertActivity({
      ...edge, action: "start", revision: 3,
      occurredAtUtc: new Date(NOW + 10_000).toISOString(),
    });
    const activity = transcript.upsertActivity({
      ...edge, action: "complete", revision: 4,
      occurredAtUtc: new Date(NOW + 13_000).toISOString(),
    });
    expect(activity.state).toBe("completed");
    expect(activity.intervals.map((interval) => interval.durationMs)).toEqual([2_000, 3_000]);
  });

  it("atomically records two compaction replacements and reconstructs only the latest Bind generation", async () => {
    const { transcript, sql } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    for (let index = 1; index <= 2; index += 1) {
      const current = transcript.readBindProjection("run-1")!;
      const compactionEventId = `run-1:compaction:${index}`;
      await transcript.reserveCompactionStatus({
        compactionEventId,
        runId: "run-1",
        trigger: "auto",
        occurredAtUtc: new Date(NOW + index * 10).toISOString(),
      });
      transcript.upsertActivity({
        activityId: compactionEventId,
        parentActivityId: null,
        scope: "compaction",
        subjectId: String(index),
        callIndex: index - 1,
        label: "Context automatically compacting",
        action: "start",
        revision: 1,
        occurredAtUtc: new Date(NOW + index * 10).toISOString(),
      });
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
            loopId: "run-1",
            generation: current.generation,
            nextGeneration: current.generation + 1,
            stateRevision: current.stateRevision + 1,
            systemProjection,
            nonSystemMessages: [{ role: "user", content: `Summary ${index}` }],
            compactionEventId,
          },
        },
        continuation: {
          executionPrincipalKey: "user:user-1",
          resourceVisibilityFingerprint: "inventory:0",
          checkpointTemplateVersion: 1,
          compactedThroughSequence: index,
          expectedInventoryRevision: 0,
        },
        now: NOW + index * 10 + 5,
      });
    }

    const projection = transcript.readBindProjection("run-1")!;
    expect(projection).toMatchObject({
      generation: 3,
      stateRevision: 3,
    });
    expect(bindLoopNonSystemMessages(projection))
      .toEqual([{ role: "user", content: "Summary 2" }]);
    expect(transcript.compactionCheckpoint({ executionPrincipalKey: "user:user-1" }))
      .toMatchObject({ run_id: "run-1", compacted_through_sequence: 2, summary: "Summary 2" });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns
      WHERE entry_kind = 'status'`).one().count).toBe(2);
    expect(transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 100,
    }).activities.filter((activity) => activity.scope === "compaction")).toEqual([
      expect.objectContaining({ activityId: "run-1:compaction:1", state: "completed" }),
      expect.objectContaining({ activityId: "run-1:compaction:2", state: "completed" }),
    ]);
    await transcript.commitBindCompaction({
      commit: {
        checkpoint: {
          trigger: "auto",
          summary: "Summary 1",
          messages: [{ role: "user", content: "Summary 1" }],
          model: "openai/test",
          contextTokensBeforeCompaction: 90,
          contextWindowTokens: 100,
          inputTokens: 10,
          outputTokens: 2,
          costCents: 0.01,
        },
        transition: {
          kind: "state_replaced",
          loopId: "run-1",
          generation: 1,
          nextGeneration: 2,
          stateRevision: 2,
          systemProjection,
          nonSystemMessages: [{ role: "user", content: "Summary 1" }],
          compactionEventId: "run-1:compaction:1",
        },
      },
      continuation: {
        executionPrincipalKey: "user:user-1",
        resourceVisibilityFingerprint: "inventory:0",
        checkpointTemplateVersion: 1,
        compactedThroughSequence: 1,
        expectedInventoryRevision: 0,
      },
    });
    expect(transcript.readBindProjection("run-1")?.generation).toBe(3);
  });

  it("commits compaction and the persistent Bind cursor atomically and heals exact replay", async () => {
    const { transcript, storage, sql, database } = open();
    seedPendingInputRoot(sql);
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Answer before compaction", now: NOW + 1,
    });
    await transcript.commitBindTransition(reserved.transition, NOW + 2, reserved.executionFence);
    const compaction = {
      commit: {
        checkpoint: {
          trigger: "auto" as const,
          summary: "Compact answer",
          messages: [{ role: "user" as const, content: "Compact answer" }],
          model: "test/model",
          contextTokensBeforeCompaction: 90,
          contextWindowTokens: 100,
          inputTokens: 10,
          outputTokens: 2,
          costCents: 0.01,
        },
        transition: {
          kind: "state_replaced" as const,
          loopId: "run-1",
          generation: 1,
          nextGeneration: 2,
          stateRevision: 4,
          systemProjection,
          nonSystemMessages: [{ role: "user" as const, content: "Compact answer" }],
          compactionEventId: "run-1:compaction:fenced",
        },
      },
      continuation: {
        executionPrincipalKey: "user:user-1",
        resourceVisibilityFingerprint: "inventory:0",
        checkpointTemplateVersion: 1,
        compactedThroughSequence: 1,
        expectedInventoryRevision: 0,
      },
      now: NOW + 3,
    };
    const fence = {
      ...reserved.executionFence,
      expectedBindStateRevision: 3,
    };
    database.exec(`CREATE TRIGGER fail_compaction_checkpoint
      BEFORE INSERT ON transcript_compaction_checkpoints
      BEGIN SELECT RAISE(ABORT, 'forced compaction failure'); END`);
    await expect(transcript.commitBindCompaction(compaction, fence))
      .rejects.toThrow("forced compaction failure");
    expect(transcript.readBindProjection("run-1")!.stateRevision).toBe(3);
    expect(new SubstreamLoopStorage(storage).loop()!.bind_state_revision).toBe(3);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM transcript_compaction_checkpoints`).one())
      .toEqual({ count: 0 });

    database.exec("DROP TRIGGER fail_compaction_checkpoint");
    await transcript.commitBindCompaction(compaction, fence);
    expect(transcript.readBindProjection("run-1")!.stateRevision).toBe(4);
    expect(new SubstreamLoopStorage(storage).loop()!.bind_state_revision).toBe(4);

    // This is the only replay repair: the checkpoint proves the Bind head
    // committed before an older process died prior to the singleton update.
    sql.exec(`UPDATE substream_loops SET bind_state_revision = 3 WHERE id = 1`);
    await transcript.commitBindCompaction(compaction, fence);
    expect(new SubstreamLoopStorage(storage).loop()!.bind_state_revision).toBe(4);
  });

  it("retains an in-progress compaction status entry with reconnect timing before replacement", async () => {
    const { transcript } = open();
    await transcript.reserveCompactionStatus({
      compactionEventId: "run-1:compaction:1",
      runId: "run-1",
      trigger: "auto",
      occurredAtUtc: new Date(NOW).toISOString(),
    });
    transcript.upsertActivity({
      activityId: "run-1:compaction:1",
      parentActivityId: null,
      scope: "compaction",
      subjectId: "1",
      callIndex: 0,
      label: "Context automatically compacting",
      action: "start",
      revision: 1,
      occurredAtUtc: new Date(NOW).toISOString(),
    });

    const snapshot = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 154_000,
    });
    expect(snapshot.ranges[0]!.turns[0]).toMatchObject({
      turnId: "run-1:compaction:1",
      entryKind: "status",
    });
    expect(snapshot.activeActivities[0]).toMatchObject({
      activityId: "run-1:compaction:1",
      state: "active",
      intervals: [{ elapsedMsAtSnapshot: 154_000 }],
    });
  });

  it("rolls back loop and participant projections together when an assistant projection fails", async () => {
    const { transcript, database, sql, storage } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const reserved = await reserveAssistantFixture({
      transcript, storage, content: "Must roll back", now: NOW + 1,
    });
    database.exec(`CREATE TRIGGER fail_assistant_projection BEFORE INSERT ON participant_transcript_turns
      WHEN NEW.actor = 'assistant' BEGIN SELECT RAISE(ABORT, 'forced projection failure'); END`);

    await expect(transcript.commitBindTransition(
      reserved.transition,
      NOW + 2,
      reserved.executionFence,
    ))
      .rejects.toThrow("forced projection failure");
    expect(transcript.readBindProjection("run-1")!.stateRevision).toBe(2);
    expect(new SubstreamLoopStorage(storage).loop()!.bind_state_revision).toBe(2);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM transcript_payloads
      WHERE payload_json LIKE '%Must roll back%'`).one().count).toBe(0);
  });

  it("uses the required indexes for unread, latest, and range queries", async () => {
    const { transcript, database, sql } = open();
    sql.exec(`INSERT INTO substreams
      (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
      VALUES ('0','main','none',0,'none','workspace','full','open',1)`);
    await transcript.appendParticipantMessage({
      turnId: "message-1",
      actor: "human",
      authorUserId: "user-1",
      authorSnapshot: { displayName: "Indexed author", avatarUrl: null },
      text: "Indexed",
      createdAtUtc: new Date(NOW).toISOString(),
      attentionOrdinal: 1,
    });
    const plans = [
      database.prepare(`EXPLAIN QUERY PLAN SELECT transcript_sequence
        FROM participant_transcript_turns INDEXED BY participant_transcript_latest_conversation_idx
        WHERE entry_kind = 'conversation'
        ORDER BY transcript_sequence DESC LIMIT 5`).all(),
      database.prepare(`EXPLAIN QUERY PLAN SELECT transcript_sequence
        FROM participant_transcript_turns INDEXED BY participant_transcript_status_idx
        WHERE entry_kind = 'status'
        ORDER BY transcript_sequence DESC LIMIT 5`).all(),
      database.prepare(`EXPLAIN QUERY PLAN SELECT transcript_sequence
        FROM participant_transcript_turns INDEXED BY participant_transcript_attention_idx
        WHERE entry_kind = 'conversation' AND attention_ordinal >= 1
        ORDER BY attention_ordinal, transcript_sequence LIMIT 1`).all(),
      database.prepare(`EXPLAIN QUERY PLAN SELECT transcript_sequence
        FROM participant_transcript_turns INDEXED BY participant_transcript_sequence_idx
        WHERE transcript_sequence >= 1 AND transcript_sequence < 10
        ORDER BY transcript_sequence`).all(),
    ].flat().map((row) => String((row as { detail: string }).detail));
    expect(plans.some((detail) => detail.includes("participant_transcript_latest_conversation_idx"))).toBe(true);
    expect(plans.some((detail) => detail.includes("participant_transcript_status_idx"))).toBe(true);
    expect(plans.some((detail) => detail.includes("participant_transcript_attention_idx"))).toBe(true);
    expect(plans.some((detail) =>
      detail.includes("INTEGER PRIMARY KEY")
      || detail.includes("participant_transcript_sequence_idx"))).toBe(true);
  });
});
