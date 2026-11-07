/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { ensureAuditSchema } from "./audit-fixture";

/**
 * Fixtures for driving an `AgentLoopDO` through its real entry points.
 *
 * The object's own tables are the seam these tests work against: an object with
 * no `workstream` row has no identity, and an execution receipt cannot be admitted
 * without one. Seeding the root here — rather than in each test — keeps the
 * tests about behaviour instead of about column lists, and keeps one place to
 * fix when the schema moves.
 */

import {
  WorkstreamWorkflowInputSchema,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { Env } from "../../src/env";
import {
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestEnv,
} from "../../test/helpers/cloudflare-test";
import { substreamLoopId } from "../../src/durable-objects/names";
import { SubstreamLoopStorage } from "../../src/durable-objects/substream-loop-storage";
import { WorkstreamTranscriptStorage } from "../../src/durable-objects/workstream-transcript-storage";
import { canonicalModelMessageJson } from "../../src/services/workstream-participant-model-message";

export const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000004a1");
export const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000004a2");
export const USER_ID = asUserId("00000000-0000-7000-8000-0000000004a3");
export const LOOP_ID = substreamLoopId(WORKSTREAM_ID);

/**
 * Create the regional control plane a work-stream object reads through: the
 * authority gate, the workspace, its one member, that member's session, and the
 * `users` row the product joins for mention resolution.
 *
 * The object owns its own SQLite, but every admission crosses into D1 for
 * membership and into WorkspaceDO for the workspace itself, so a suite that
 * drives real admissions needs both. Shared rather than restated per suite for
 * the reason the root seed above is: a column list belongs in one place, and a
 * test should be about behaviour.
 */
export async function seedWorkspaceControlPlane(
  database: D1Database,
  input: { workspaceId: string; userId: string; sessionId: string },
): Promise<void> {
  await ensureAuditSchema();
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS sidekick_delegation_locations (
      user_id TEXT NOT NULL,workspace_id TEXT NOT NULL,region TEXT NOT NULL,PRIMARY KEY(user_id,workspace_id)
    )`),
    database.prepare(`CREATE TABLE workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    database.prepare(`INSERT INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    database.prepare(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT,
      timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles'
    )`),
    database.prepare(`INSERT INTO workspaces(id, region) VALUES (?, 'global')`)
      .bind(input.workspaceId),
    database.prepare(`CREATE TABLE workspace_members (revision INTEGER NOT NULL DEFAULT 1, access_class TEXT NOT NULL DEFAULT 'member', incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, joined_at TEXT, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    database.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`)
      .bind(input.workspaceId, input.userId),
    database.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL,
      impersonator_user_id TEXT
    )`),
    database.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(input.sessionId, input.userId, input.workspaceId),
    database.prepare(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
    )`),
    database.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'member@example.com', 'Member', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(input.userId),
  ]);
}

/** Declare the production authority state required by all run ingress. */
export async function seedOpenWorkstreamAuthority(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY,
      phase TEXT NOT NULL,
      generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    database.prepare(`INSERT INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)
      ON CONFLICT(id) DO UPDATE SET
        phase = excluded.phase,
        generation = excluded.generation,
        required_serving_contract_version = excluded.required_serving_contract_version,
        serving_contract_version = excluded.serving_contract_version`),
  ]);
}

/** Immutable context carried by one subordinate execution receipt. */
export function runInput(
  runId: string,
  overrides: Record<string, unknown> = {},
): WorkstreamWorkflowInput {
  return WorkstreamWorkflowInputSchema.parse({
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId: WORKSTREAM_ID,
    substreamId: "0",
    loopId: LOOP_ID,
    harnessRunId: runId,
    triggerMessageId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: "user_message",
    ...overrides,
  });
}

/** Gives the object the identity and main substream its singleton loop requires. */
export function seedWorkstreamRoot(
  state: DurableObjectState,
  now = 1,
  identity: { workspaceId?: string; workstreamId?: string } = {},
): void {
  const workspaceId = identity.workspaceId ?? WORKSPACE_ID;
  const workstreamId = identity.workstreamId ?? WORKSTREAM_ID;
  state.storage.sql.exec(
    `INSERT INTO workstream (
       id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
       authority_mode, authority_generation, title, description, preview, scope,
       exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
       unread_tracking_start_ordinal, authority_epoch, scope_epoch,
       source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
       created_at, last_people_activity_at, state_changed_at, updated_at
     ) VALUES (
       1, ?, ?, NULL, 0, 'global',
       'authoritative', 1, 'Fixture', '', '', 'workspace',
       'idle', 'seeded', 1, 1,
       0, 0, 0,
       0, 0, 0, 0,
       ?, ?, ?, ?
     ) ON CONFLICT(id) DO NOTHING`,
    workstreamId,
    workspaceId,
    now,
    now,
    now,
    now,
  );
  state.storage.sql.exec(
    `INSERT INTO substreams
       (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
     VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', ?)
     ON CONFLICT(id) DO NOTHING`,
    now,
  );
  state.storage.sql.exec(
    `INSERT INTO substream_agent_identity (id, external_substream_id, created_at, updated_at)
     VALUES (1, '0', ?, ?) ON CONFLICT(id) DO NOTHING`,
    now,
    now,
  );
}

/** Seed one participant-visible message through the canonical transcript owner. */
export async function seedParticipantMessage(
  state: DurableObjectState,
  input: {
    id: string;
    sequence: number;
    text: string;
    authorType?: "human" | "agent" | "external" | "system";
    authorUserId?: string | null;
    clientMessageId?: string;
    messageType?: "text" | "system" | "elicitation";
    structuredContentJson?: string | null;
    externalActorJson?: string | null;
    attentionOrdinal?: number | null;
    now?: number;
  },
): Promise<void> {
  const authorType = input.authorType ?? "human";
  const now = input.now ?? input.sequence;
  await new WorkstreamTranscriptStorage(state.storage).appendParticipantMessage({
    turnId: input.id,
    actor: authorType === "agent" ? "assistant" : authorType,
    authorUserId: input.authorUserId ?? (authorType === "human" ? USER_ID : null),
    authorSnapshot: authorType === "human"
      ? { displayName: "Test user", avatarUrl: null }
      : null,
    clientMessageId: input.clientMessageId ?? input.id,
    messageType: input.messageType ?? "text",
    text: input.text,
    structuredContentJson: input.structuredContentJson ?? null,
    externalActorJson: input.externalActorJson ?? null,
    producedByRunId: null,
    messageSequenceNumber: input.sequence,
    createdAtUtc: new Date(now).toISOString(),
    attentionOrdinal: input.attentionOrdinal ?? null,
  });
}

/** Seed a canonical tool or operational message without advancing root counters. */
export async function seedCanonicalMessageRecord(
  state: DurableObjectState,
  input: {
    id: string;
    sequence: number;
    messageType: "text" | "system" | "elicitation" | "tool" | "suggestion";
    text?: string;
    structuredContentJson?: string | null;
    toolName?: string | null;
    toolStatus?: "pending" | "completed" | "failed" | "ambiguous" | null;
    effectIntentId?: string | null;
    clientMessageId?: string;
    now?: number;
  },
): Promise<void> {
  const now = input.now ?? input.sequence;
  const transcript = new WorkstreamTranscriptStorage(state.storage);
  await transcript.appendParticipantMessage({
    turnId: input.id,
    actor: "assistant",
    authorUserId: null,
    authorSnapshot: null,
    clientMessageId: input.clientMessageId ?? input.id,
    messageType: input.messageType === "tool" || input.messageType === "suggestion"
      ? "text"
      : input.messageType,
    text: input.text ?? "",
    structuredContentJson: input.structuredContentJson ?? null,
    producedByRunId: null,
    messageSequenceNumber: input.sequence,
    createdAtUtc: new Date(now).toISOString(),
    attentionOrdinal: null,
  });
  if (input.messageType === "tool") {
    state.storage.sql.exec(
      `UPDATE participant_transcript_blocks
          SET block_kind = 'tool', tool_call_id = ?, tool_name = ?,
              lifecycle_state = ?, revision = revision + 1
        WHERE turn_id = ? AND block_index = 0`,
      input.effectIntentId ?? input.id,
      input.toolName ?? "Tool",
      input.toolStatus === "pending" ? "started" : input.toolStatus ?? "completed",
      input.id,
    );
  }
}

/** A subordinate run row before immutable execution context is attached. */
export function seedRun(
  state: DurableObjectState,
  runId: string,
  status: "admitted" | "running" = "admitted",
  now = 1,
): void {
  state.storage.sql.exec(
    `INSERT INTO runs (
       run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
       model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
       active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
       tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
       created_at, updated_at
     ) VALUES (?, '0', NULL, ?, '{}', 0, 0, '', 0, 0, ?,
               0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
    runId,
    status,
    now,
    now,
    now,
  );
}

/** Seed a crash-recoverable execution receipt without activating its loop. */
export function seedExecutionReceipt(
  state: DurableObjectState,
  runId: string,
  input: WorkstreamWorkflowInput = runInput(runId),
  now = 1,
): void {
  seedRun(state, runId, "admitted", now);
  state.storage.sql.exec(
    `UPDATE runs SET execution_context_json = ?, execution_available_at = ?, updated_at = ?
      WHERE run_id = ?`,
    JSON.stringify(input),
    now,
    now,
    runId,
  );
}

export interface ExecutionReceiptSnapshot extends Record<string, SqlStorageValue> {
  run_id: string;
  status: string;
  execution_context_json: string | null;
  execution_available_at: number | null;
  substream_loop_id: string | null;
  loop_cycle_ordinal: number | null;
  loop_execution_id: string | null;
  loop_execution_epoch: number | null;
  loop_execution_sequence: number | null;
}

export function executionReceipts(state: DurableObjectState): ExecutionReceiptSnapshot[] {
  return state.storage.sql.exec<ExecutionReceiptSnapshot>(
    `SELECT run_id, status, execution_context_json, execution_available_at,
            substream_loop_id, loop_cycle_ordinal, loop_execution_id, loop_execution_epoch,
            loop_execution_sequence
       FROM runs WHERE execution_context_json IS NOT NULL ORDER BY created_at, run_id`,
  ).toArray();
}

/** Ensure and return the one stable main-substream loop for a fixture root. */
export function ensureFixtureLoop(state: DurableObjectState, now = 1) {
  return new SubstreamLoopStorage(state.storage).ensureLoop({
    loopId: LOOP_ID,
    bindStateRevision: 0,
    now,
  });
}

export function activateFixtureReceipt(
  state: DurableObjectState,
  runId: string,
  input: { leaseOwner: string; leaseExpiresAt: number; now: number },
) {
  const storage = new SubstreamLoopStorage(state.storage);
  const loop = storage.loop() ?? ensureFixtureLoop(state, input.now);
  return storage.activateExecutionReceipt({
    runId,
    loopId: LOOP_ID,
    expectedLoopRevision: loop.revision,
    expectedBindStateRevision: loop.bind_state_revision,
    executionEpoch: 1,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: input.leaseExpiresAt,
    now: input.now,
  }).loop;
}

/** Admit one immutable human input without going through the HTTP product API. */
export async function admitFixturePendingInput(
  state: DurableObjectState,
  input: {
    inputId: string;
    text: string;
    mode?: "steer" | "queue";
    startsRun?: boolean;
    clientMessageId?: string;
    loopId?: string;
    now?: number;
  },
) {
  const now = input.now ?? Date.now();
  const loops = new SubstreamLoopStorage(state.storage);
  const loopId = input.loopId ?? LOOP_ID;
  if (!loops.loop()) loops.ensureLoop({ loopId, bindStateRevision: 0, now });
  const clientMessageId = input.clientMessageId ?? input.inputId;
  loops.reserveInputPreparation({
    inputId: input.inputId,
    loopId,
    clientMessageId,
    preparationKind: "human_message",
    envelopeJson: JSON.stringify({ input: { text: input.text } }),
    now,
  });
  const prepared = await new WorkstreamTranscriptStorage(state.storage)
    .prepareParticipantMessage({
      turnId: input.inputId,
      actor: "human",
      authorUserId: USER_ID,
      authorSnapshot: { displayName: "Test user", avatarUrl: null },
      clientMessageId,
      messageType: "text",
      text: input.text,
      structuredContentJson: null,
      externalActorJson: null,
      producedByRunId: null,
      messageSequenceNumber: 1,
      createdAtUtc: new Date(now).toISOString(),
      attentionOrdinal: null,
    });
  return loops.completeInputPreparation({
    inputId: input.inputId,
    preparedTurnId: input.inputId,
    mode: input.mode ?? "steer",
    actor: "human",
    authorUserId: USER_ID,
    authorNameSnapshot: "Test user",
    authorAvatarUrlSnapshot: null,
    clientMessageId,
    externalActorJson: null,
    messageType: "text",
    preparedPayloadId: prepared.fact.payloadId,
    preparedFactId: prepared.fact.factId,
    preparedPayloadAudience: prepared.fact.audience,
    preparedPayloadMediaType: "application/json",
    preparedPayloadJson: prepared.fact.canonical,
    bindPayloadJson: canonicalModelMessageJson({ role: "user", content: input.text }),
    preparedPayloadSha256: prepared.fact.hash,
    preparedPayloadByteLength: new TextEncoder().encode(prepared.fact.canonical).byteLength,
    provenanceJson: JSON.stringify({
      factKind: prepared.fact.factKind,
      originKind: prepared.fact.origin.originKind,
      sourceKind: prepared.fact.origin.sourceKind,
      sourceId: prepared.fact.origin.sourceId,
      sourceRevision: prepared.fact.origin.sourceRevision,
      runId: prepared.fact.runId,
      toolCallId: prepared.fact.toolCallId,
    }),
    authorizationJson: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      executionPrincipal: { type: "user", userId: USER_ID },
      confirmedParticipantUserIds: [],
      // The product writes one epoch per authorized participant (author plus
      // confirmed), read from the participants table; hydration refuses an
      // authorization whose epoch keys do not cover exactly that set. Mirror
      // the real shape — a seat may not exist yet in a bare fixture, which is
      // the same null the product records for an unseated user.
      participantEpochs: {
        [USER_ID]: state.storage.sql.exec<{ participant_epoch: number }>(
          `SELECT participant_epoch FROM participants WHERE user_id = ?`,
          USER_ID,
        ).toArray()[0]?.participant_epoch ?? null,
      },
      reason: "human_message",
    }),
    attachmentsJson: "[]",
    mentionsJson: "[]",
    startsRun: input.startsRun ?? true,
    now,
  });
}

/**
 * Pin the persistent loop in `executing` under a live lease held by nobody in
 * this test, so queued inputs stay pending instead of being claimed the moment
 * a background alarm drains the object. This is the durable shape of "a step
 * is in flight while the queue grows" — the one state in which a large
 * pending-only queue can actually be observed. Raw SQL because the only
 * product path into `executing` claims a real execution receipt, which is the
 * machinery these tests are deliberately not running.
 */
export function holdLoopExecuting(
  state: DurableObjectState,
  input: { loopId?: string; now?: number } = {},
): void {
  const now = input.now ?? Date.now();
  const loops = new SubstreamLoopStorage(state.storage);
  const loopId = input.loopId ?? LOOP_ID;
  if (!loops.loop()) loops.ensureLoop({ loopId, bindStateRevision: 0, now });
  // `idle` OR an activation that got here first. Admissions schedule loop
  // activation a millisecond out, and under a full-suite run that alarm can
  // fire between the object's last await and this call — so a hold that only
  // accepted `idle` failed with `loop_hold_failed` on a slow machine while
  // passing every time in isolation. Taking over the lease is not hiding that
  // race: the loop being in flight is the state these tests are asking for,
  // and if the activation had already promoted the pending inputs, the test's
  // own assertions still say so, in their own words rather than as a fixture
  // crash. `releaseHeldLoop` keys on `test-holder`, so the loop is left owned
  // by whoever holds it here either way.
  const held = state.storage.sql.exec<{ loop_id: string }>(
    `UPDATE substream_loops
        SET status = 'executing', active_execution_id = 'held-execution',
            active_execution_epoch = 1, lease_owner = 'test-holder',
            lease_expires_at = ?, cycle_ordinal = cycle_ordinal + 1,
            revision = revision + 1, updated_at = MAX(updated_at, ?)
      WHERE id = 1 AND loop_id = ? AND status IN ('idle', 'executing')
      RETURNING loop_id`,
    now + 60_000,
    now,
    loopId,
  ).toArray();
  if (held.length !== 1) {
    const actual = state.storage.sql.exec<{ status: string }>(
      `SELECT status FROM substream_loops WHERE id = 1 AND loop_id = ?`, loopId,
    ).toArray()[0]?.status ?? "absent";
    throw new Error(`loop_hold_failed:${actual}`);
  }
}

/** Release a `holdLoopExecuting` hold so the loop can activate normally. */
export function releaseHeldLoop(state: DurableObjectState): void {
  const released = state.storage.sql.exec<{ loop_id: string }>(
    `UPDATE substream_loops
        SET status = 'idle', active_execution_id = NULL,
            active_execution_epoch = NULL, lease_owner = NULL,
            lease_expires_at = NULL, revision = revision + 1,
            updated_at = MAX(updated_at, ?)
      WHERE id = 1 AND status = 'executing' AND lease_owner = 'test-holder'
      RETURNING loop_id`,
    Date.now(),
  ).toArray();
  if (released.length !== 1) throw new Error("loop_release_failed");
}

export function runStatus(state: DurableObjectState, runId: string): string | null {
  return state.storage.sql.exec<{ status: string }>(
    `SELECT status FROM runs WHERE run_id = ?`,
    runId,
  ).toArray()[0]?.status ?? null;
}

export async function post(
  stub: DurableObjectStub,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await stub.fetch(`https://object.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

export async function boot(stub: DurableObjectStub): Promise<void> {
  const response = await stub.fetch("https://object.test/health");
  await response.arrayBuffer();
}

/**
 * Park the *first* D1 read this object makes, and let every later one through.
 *
 * `createMessage` commits its mailbox reservation and then awaits `authorize`,
 * which is a D1 read — so holding that read parks the admission with its
 * reservation durable and nothing having settled it. That is the state a
 * cancelled invocation leaves behind, and it is also how a test puts a second
 * message behind the head-of-line gate on purpose. Only the first read is held,
 * so whatever the test wants to happen next still can. Only the external system
 * is replaced; the product runs its real admission against real storage.
 */
type AdmissionGateGlobal = typeof globalThis & {
  __rallySubstreamAdmissionGate?: { open: boolean };
};

export function holdFirstWorkspaceRead(product: { env: Env }): { open: boolean } {
  const scope = globalThis as AdmissionGateGlobal;
  const gate = { open: false };
  scope.__rallySubstreamAdmissionGate = gate;
  let parked = false;
  const hold = async (): Promise<void> => {
    if (parked) return;
    parked = true;
    while (!gate.open) await scheduler.wait(10);
  };
  const holdStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    createTestD1PreparedStatement({
      bind: (...values: unknown[]) => holdStatement(statement.bind(...values)),
      first: async () => { await hold(); return statement.first(); },
      all: async () => { await hold(); return statement.all(); },
      run: async () => { await hold(); return statement.run(); },
      raw: async () => { await hold(); return statement.raw(); },
    });
  const database = product.env.DB;
  product.env = createTestEnv({
    ...product.env,
    DB: createTestD1Database({ prepare: (query: string) => holdStatement(database.prepare(query)) }),
  });
  return gate;
}
