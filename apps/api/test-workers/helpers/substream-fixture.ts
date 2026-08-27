/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Fixtures for driving a `SubstreamAgent` through its real entry points.
 *
 * The object's own tables are the seam these tests work against: an object with
 * no `workstream` row has no identity, and a dispatch cannot be admitted
 * without one. Seeding the root here — rather than in each test — keeps the
 * tests about behaviour instead of about column lists, and keeps one place to
 * fix when the schema moves.
 */

import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import {
  insertWorkstreamMessageRecord,
  prepareWorkstreamMessageRecord,
  WorkstreamTranscriptStorage,
} from "../../src/durable-objects/workstream-transcript-storage";

export const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000004a1");
export const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000004a2");
export const USER_ID = asUserId("00000000-0000-7000-8000-0000000004a3");

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

/** A dispatch payload that satisfies `WorkstreamWorkflowInputSchema`. */
export function runInput(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    substreamId: "0",
    harnessRunId: runId,
    triggerMessageId: null,
    automationSubscriptionId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: "user_message",
    ...overrides,
  };
}

/** Gives the object the identity and main substream a dispatch requires. */
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
  const prepared = await prepareWorkstreamMessageRecord({
    messageId: input.id,
    clientMessageId: input.clientMessageId ?? input.id,
    authorType: "agent",
    authorUserId: null,
    externalActorJson: null,
    messageType: input.messageType,
    text: input.text ?? "",
    structuredContentJson: input.structuredContentJson ?? null,
    producedByRunId: null,
    role: "assistant",
    kind: input.messageType === "tool" ? "tool_call" : "text",
    effectIntentId: input.effectIntentId ?? null,
    toolName: input.toolName ?? null,
    toolMode: input.messageType === "tool" ? "read" : null,
    toolStatus: input.toolStatus ?? null,
    visibility: "people",
    sequenceNumber: input.sequence,
    attentionOrdinal: null,
    now,
  });
  state.storage.transactionSync(() => insertWorkstreamMessageRecord(state.storage.sql, prepared));
}

/** A run row in the state a dispatch expects to find it. */
export function seedRun(
  state: DurableObjectState,
  runId: string,
  status: "admitted" | "running" | "waiting" | "steering" = "admitted",
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

export interface DispatchSnapshot extends Record<string, SqlStorageValue> {
  run_id: string;
  state: string;
  attempt: number;
  available_at: number;
  started_at: number | null;
  completed_at: number | null;
  last_error_code: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
}

export function dispatches(state: DurableObjectState): DispatchSnapshot[] {
  return state.storage.sql.exec<DispatchSnapshot>(
    `SELECT run_id, state, attempt, available_at, started_at, completed_at,
            last_error_code, lease_token, lease_expires_at
       FROM agent_run_dispatches ORDER BY created_at, run_id`,
  ).toArray();
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
