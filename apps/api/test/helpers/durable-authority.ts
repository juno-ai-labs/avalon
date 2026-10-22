import { ParticipantAuthorityTransferStorage } from "../../src/durable-objects/participant-authority-transfer";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import type { WorkstreamAppearance } from "@rally/contracts";

import { applyWorkstreamObjectSchema } from "../../src/durable-objects/workstream-object-schema";
import {
  TOOL_RECEIPT_OPERATIONS,
  type ToolReceiptObjectPort,
  type ToolReceiptOperation,
} from "../../src/durable-objects/workstream-tool-receipt-protocol";
import { WorkstreamMessageStorage } from "../../src/durable-objects/workstream-message-storage";
import {
  MESSAGE_OPERATIONS,
  type MessageObjectPort,
} from "../../src/durable-objects/workstream-message-protocol";
import { WorkstreamHarnessRunStorage } from "../../src/durable-objects/workstream-harness-run-storage";
import {
  HARNESS_RUN_OPERATIONS,
  type HarnessRunObjectPort,
} from "../../src/durable-objects/workstream-harness-run-protocol";
import { WorkstreamIdentityStorage } from "../../src/durable-objects/workstream-identity-storage";
import { WorkstreamObjectProductService } from "../../src/durable-objects/workstream-object-product";
import { WorkstreamObjectStore } from "../../src/durable-objects/workstream-object-storage";
import { WorkstreamResourceStorage } from "../../src/durable-objects/workstream-resource-storage";
import {
  RESOURCE_OPERATIONS,
  type ResourceObjectPort,
  type ResourceOperation,
} from "../../src/durable-objects/workstream-resource-protocol";
import { WorkstreamSchedulingStorage } from "../../src/durable-objects/workstream-scheduling-storage";
import {
  SCHEDULING_OPERATIONS,
  type SchedulingObjectPort,
  type SchedulingOperation,
} from "../../src/durable-objects/workstream-scheduling-protocol";
import { WorkstreamToolReceiptStorage } from "../../src/durable-objects/workstream-tool-receipt-storage";
import { WorkstreamTranscriptStorage } from "../../src/durable-objects/workstream-transcript-storage";
import {
  TRANSCRIPT_OPERATIONS,
  type TranscriptObjectPort,
  type TranscriptOperation,
} from "../../src/durable-objects/workstream-transcript-protocol";
import { WorkstreamTerminalStorage } from "../../src/durable-objects/workstream-terminal-storage";
import {
  createTerminalPortFactory,
  type TerminalOperationExecutor,
  type TerminalPortFactory,
} from "../../src/services/terminal/object-port";
import { AUTHORITY_FENCED_CODE } from "../../src/runtime/object-port-error";
import { createCloudflareTestBinding, createTestDurableObjectId, createTestEnv } from "./cloudflare-test";
import { sqliteD1 } from "./sqlite-d1";
import { createTestSqlStorage } from "./sql-storage";
import {
  conversationResourceLinks,
  type ConversationResourceLinks,
} from "../../src/services/workstream-resource-visibility";

/**
 * Walk the regional cutover ledger to `durable_object_open` the way the
 * campaign does — the phase transitions are trigger-enforced, so a test cannot
 * simply UPDATE straight to the open phase — and then disarm the post-cutover
 * D1 fences.
 *
 * The fences exist to abort object-owned statements that leak back to D1. A
 * unit test that pairs this helper with {@link testSubstreamAgentsBinding}
 * carries product operations through typed ports into a real object database,
 * so the fences would only re-refuse regional bookkeeping writes
 * (`artifacts`, effect receipts) that production performs from inside the
 * objects. Tests that arm the fences on purpose (to prove a statement does not
 * leak) should skip this helper's disarm, as `slack-thread-audience.test.ts`
 * does.
 */
export function openWorkstreamAuthorityForTest(
  database: DatabaseSync,
  at = "2026-01-02T00:00:00.000Z",
): void {
  database.exec(`
    UPDATE workstream_authority_control SET phase = 'maintenance_draining', generation = 1, updated_at = '${at}' WHERE id = 1;
    UPDATE workstream_authority_control SET phase = 'maintenance_importing', updated_at = '${at}' WHERE id = 1;
    UPDATE workstream_authority_routes SET state = 'verified', updated_at = '${at}';
  `);
  // Some compatibility tests deliberately start from a historical schema.
  // Advance its one-time cutover row only when that old table is actually
  // present; current migrated D1 has no workspace authority ledger.
  const hasHistoricalWorkspaceLedger = database.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_product_authority_routes'",
  ).get() !== undefined;
  if (hasHistoricalWorkspaceLedger) {
    database.exec(`
      UPDATE workspace_product_authority_routes SET state = 'verified', updated_at = '${at}';
    `);
  }
  database.exec(`
    UPDATE workstream_authority_control SET phase = 'maintenance_verified', updated_at = '${at}' WHERE id = 1;
    UPDATE workstream_authority_routes SET state = 'active', activated_at = '${at}', updated_at = '${at}';
  `);
  if (hasHistoricalWorkspaceLedger) {
    database.exec(`
      UPDATE workspace_product_authority_routes SET state = 'active', updated_at = '${at}';
    `);
  }
  database.exec(`
    UPDATE workstream_authority_control SET phase = 'durable_object_open', serving_contract_version = 1, updated_at = '${at}' WHERE id = 1;
  `);
  const fences = database.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND (
       name LIKE '%reject_do_authority%'
       OR name LIKE '%reject_workspace_do%'
       OR name LIKE '%reject_post_cutover%'
     )`,
  ).all() as Array<{ name: string }>;
  for (const { name } of fences) database.exec(`DROP TRIGGER "${String(name)}"`);
}

/**
 * The workerd-shaped SqlStorage adapter for an object database, one per
 * DatabaseSync so cursor bookkeeping (`rowsWritten`) and the foreign-key
 * pragma are applied exactly once.
 */
const objectSqlStorages = new WeakMap<DatabaseSync, SqlStorage>();

function objectSqlStorage(database: DatabaseSync): SqlStorage {
  let sql = objectSqlStorages.get(database);
  if (!sql) {
    sql = createTestSqlStorage(database);
    objectSqlStorages.set(database, sql);
  }
  return sql;
}

/**
 * A real WorkstreamDO object database: the normalized object schema applied
 * over node:sqlite with workerd semantics, including enforced foreign keys.
 * Typed production ports execute against this store; migration 0090 dropped
 * the regional D1 copies, so tests cannot stand a migrated regional database
 * in for work-stream product authority.
 *
 * The root identity row is not seeded here — {@link seedWorkstreamObjectRoot}
 * does that, and {@link testSubstreamAgentsBinding} seeds lazily from the ids
 * on each routed request. The caller owns closing the database, exactly like
 * every other test database.
 */
export function testWorkstreamObjectStore(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const sql = objectSqlStorage(database);
  applyWorkstreamObjectSchema(
    createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(),
      sql,
    }),
    "durable-authority-test",
    Date.parse("2026-01-02T00:00:00.000Z"),
  );
  return database;
}

/**
 * Seeds one canonical conversation turn without recreating any retired SQL
 * vocabulary. This is fixture setup, not a second transcript implementation:
 * behavioral writes should use {@link testMessagePort}; tests that need a
 * pre-existing causal turn can state the canonical identity/order directly.
 */
interface CanonicalFixtureDatabase {
  prepare(sql: string): {
    get(...params: Array<string | number | null>): unknown;
    run(...params: Array<string | number | null>): unknown;
  };
}

export function seedCanonicalConversationTurn(database: CanonicalFixtureDatabase, input: {
  turnId: string;
  clientMessageId?: string | null;
  actor: "human" | "assistant" | "external" | "system";
  authorUserId?: string | null;
  authorSnapshot: { displayName: string; avatarUrl: string | null } | null;
  externalActorJson?: string | null;
  messageType?: "text" | "system" | "elicitation" | "tool";
  text: string;
  structuredContentJson?: string | null;
  transcriptSequence: number;
  createdAt: string | number;
  producedByRunId?: string | null;
}): void {
  const createdAt = typeof input.createdAt === "number" ? input.createdAt : Date.parse(input.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error("canonical_fixture_created_at_invalid");
  const payloadId = `${input.turnId}:fixture-payload`;
  const factId = `${input.turnId}:fixture-fact`;
  const messageType = input.messageType ?? "text";
  const structuredContent = input.structuredContentJson === null
    || input.structuredContentJson === undefined
    ? null
    : JSON.parse(input.structuredContentJson) as unknown;
  const payloadJson = JSON.stringify({
    role: input.actor === "assistant" ? "assistant" : input.actor === "system" ? "system" : "user",
    content: input.text,
    structuredContent,
  });
  const attentionOrdinal = messageType === "tool"
    ? null
    : Number((database.prepare(
      `SELECT next_attention_ordinal FROM workstream WHERE id = 1`,
    ).get() as { next_attention_ordinal: number }).next_attention_ordinal);
  const authorUserId = input.authorUserId ?? null;
  const authorSnapshot = input.authorSnapshot;
  if (input.actor === "human" && (!authorUserId || !authorSnapshot?.displayName.trim())) {
    throw new Error("canonical_fixture_human_author_required");
  }
  if (input.actor !== "human" && (authorUserId !== null || authorSnapshot !== null)) {
    throw new Error("canonical_fixture_nonhuman_author_invalid");
  }
  // Fixtures can receive the runtime-routing facade whose individual writes
  // are already transactional. Keep setup idempotent without pretending a
  // multi-statement transaction can span that production-shaped boundary.
  database.prepare(`DELETE FROM transcript_facts WHERE fact_id = ?`).run(factId);
  database.prepare(`DELETE FROM transcript_payloads WHERE payload_id = ?`).run(payloadId);
    database.prepare(
      `INSERT INTO transcript_payloads
         (payload_id, audience, media_type, payload_json, payload_sha256, byte_length, created_at)
       VALUES (?, 'shared', 'application/json', ?, ?, ?, ?)`,
    ).run(payloadId, payloadJson, payloadId, new TextEncoder().encode(payloadJson).byteLength, createdAt);
    database.prepare(
      `INSERT INTO transcript_facts
         (fact_id, fact_kind, payload_id, origin_kind, run_id, turn_id, created_at)
       VALUES (?, 'participant_message', ?, 'canonical', ?, ?, ?)`,
    ).run(factId, payloadId, input.producedByRunId ?? null, input.turnId, createdAt);
    database.prepare(
      `INSERT INTO participant_transcript_turns
         (transcript_sequence, turn_id, entry_kind, actor, author_user_id, root_fact_id,
          activity_id, attention_ordinal, revision, created_at, updated_at,
          client_message_id, external_actor_json, message_type,
          author_name_snapshot, author_avatar_url_snapshot)
       VALUES (?, ?, 'conversation', ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.transcriptSequence,
      input.turnId,
      input.actor,
      authorUserId,
      factId,
      attentionOrdinal,
      createdAt,
      createdAt,
      input.clientMessageId ?? null,
      input.externalActorJson ?? null,
      messageType,
      authorSnapshot?.displayName ?? null,
      authorSnapshot?.avatarUrl ?? null,
    );
    const invocation = structuredContent && typeof structuredContent === "object"
      ? (structuredContent as { invocation?: { toolCallId?: string; toolName?: string; status?: string } }).invocation
      : undefined;
    const plannedToolCallId = messageType === "tool"
      ? (database.prepare(
        `SELECT tool_call_id FROM tool_effects WHERE effect_intent_id = ?`,
      ).get(input.turnId) as { tool_call_id: string } | undefined)?.tool_call_id
      : undefined;
    database.prepare(
      `INSERT INTO participant_transcript_blocks
         (turn_id, block_id, block_index, block_kind, fact_id, tool_call_id,
          tool_name, lifecycle_state, revision, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      input.turnId,
      `${input.turnId}:${messageType === "tool" ? "tool" : "text"}:0`,
      messageType === "tool" ? "tool" : "text",
      factId,
      messageType === "tool" ? plannedToolCallId ?? invocation?.toolCallId ?? input.turnId : null,
      messageType === "tool" ? invocation?.toolName ?? "fixture_tool" : null,
      messageType === "tool" ? invocation?.status ?? "started" : null,
      createdAt,
    );
    database.prepare(
      `UPDATE transcript_counters
          SET next_transcript_sequence = MAX(next_transcript_sequence, ?), updated_at = ?
        WHERE id = 1`,
    ).run(input.transcriptSequence + 1, createdAt);
    database.prepare(
      `UPDATE workstream
          SET next_sequence_number = MAX(next_sequence_number, ?),
              next_attention_ordinal = next_attention_ordinal + ?, updated_at = ?
        WHERE id = 1`,
    ).run(input.transcriptSequence + 1, messageType === "tool" ? 0 : 1, createdAt);
}

/**
 * What a fixture says a work stream *is*, in the object's own columns.
 *
 * Every field is optional and every name is the object's, not the retired
 * `_runtime_workstreams` view's: `description` rather than `objective`,
 * `exactState` rather than the `harnessStatus` bucket, unix milliseconds
 * rather than ISO-8601. A fixture that wants the published shape crosses at
 * its own assertion, which is where the two vocabularies meet everywhere else.
 */
export interface WorkstreamObjectRootFields {
  title?: string;
  description?: string;
  descriptionSource?: "authored" | "derived";
  titleStatus?: "naming" | "automatic" | "settled";
  scope?: "personal" | "workspace";
  exactState?: string;
  stateReasonCode?: string;
  originType?: string;
  systemKind?: string | null;
  createdByUserId?: string | null;
  automationSubscriptionId?: string | null;
  automationRunId?: string | null;
  createdFromOpportunityId?: string | null;
  plannedFor?: number | null;
  emailAddress?: string | null;
  emailRouteStatus?: string;
  modelOverride?: string | null;
  /** The shared icon and colour, stated as the object stores it. */
  appearance?: WorkstreamAppearance | null;
  archivedAt?: number | null;
  nextSequenceNumber?: number;
  nextAttentionOrdinal?: number;
  lastPeopleActivityAt?: number;
}

/**
 * Give the object the identity root and main substream every operation
 * requires: the storage classes read `workstream` id = 1 for the workspace and
 * workstream keys, and run rows hang off substream '0'. Mirrors the workerd
 * fixture in `test-workers/helpers/substream-fixture.ts`, which cannot be
 * imported from the node-side suite.
 *
 * Product state is stated here rather than written by a second statement.
 * Fixtures used to seed this root and then `INSERT INTO workstreams (…)`,
 * letting the compatibility trigger translate the old vocabulary into an
 * `UPDATE` of the row that had just been created — two statements for one
 * fact, and the reason nineteen call sites named a view instead of a table.
 * With the view retired there is nothing to translate, so the fixture says
 * what it means. Same shape and same reasoning as {@link seedToolReceipt}.
 *
 * The identity keys stay idempotent: an existing root keeps its workspace and
 * workstream ids so a mismatch surfaces instead of being overwritten. Product
 * fields are applied on every call, because a fixture that states them is
 * describing the work stream it wants rather than racing another writer.
 */
export function seedWorkstreamObjectRoot(
  database: DatabaseSync,
  ids: { workstreamId: string; workspaceId: string } & WorkstreamObjectRootFields,
  now = Date.parse("2026-01-02T00:00:00.000Z"),
): void {
  database.prepare(
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
  ).run(ids.workstreamId, ids.workspaceId, now, now, now, now);
  database.prepare(
    `INSERT INTO substreams
       (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
     VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(now);
  database.prepare(
    `INSERT INTO substream_agent_identity (id, external_substream_id, created_at, updated_at)
     VALUES (1, '0', ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(now, now);
  applyWorkstreamObjectRootFields(database, ids, now);
}

/** The object columns each fixture field writes, in one place. */
const ROOT_FIELD_COLUMNS: ReadonlyArray<[keyof WorkstreamObjectRootFields, string]> = [
  ["title", "title"],
  ["description", "description"],
  ["descriptionSource", "description_source"],
  ["titleStatus", "title_status"],
  ["scope", "scope"],
  ["exactState", "exact_state"],
  ["stateReasonCode", "state_reason_code"],
  ["originType", "origin_type"],
  ["systemKind", "system_kind"],
  ["createdByUserId", "created_by_user_id"],
  ["automationSubscriptionId", "automation_subscription_id"],
  ["automationRunId", "automation_run_id"],
  ["createdFromOpportunityId", "created_from_opportunity_id"],
  ["plannedFor", "planned_for"],
  ["emailAddress", "email_address"],
  ["emailRouteStatus", "email_route_status"],
  ["modelOverride", "model_override"],
  ["appearance", "appearance_json"],
  ["archivedAt", "archived_at"],
  ["nextSequenceNumber", "next_sequence_number"],
  ["nextAttentionOrdinal", "next_attention_ordinal"],
  ["lastPeopleActivityAt", "last_people_activity_at"],
];

/**
 * Write the product fields a fixture stated onto an already-seeded root.
 *
 * Exported so a test can move a work stream mid-run — a title settling, a work
 * stream being archived — without restating the identity it was seeded with.
 * `undefined` leaves a column alone; `null` writes NULL, which is the whole
 * point for the nullable ones.
 */
export function applyWorkstreamObjectRootFields(
  database: DatabaseSync,
  fields: WorkstreamObjectRootFields,
  now = Date.parse("2026-01-02T00:00:00.000Z"),
): void {
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [field, column] of ROOT_FIELD_COLUMNS) {
    const value = fields[field];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    // The one field the object stores as JSON. Serializing here keeps a fixture
    // stating the appearance rather than the encoding, and keeps the column's
    // `json_valid` check something the fixture cannot get wrong.
    values.push(typeof value === "object" && value !== null ? JSON.stringify(value) : value);
  }
  if (assignments.length === 0) return;
  database.prepare(
    `UPDATE workstream SET ${assignments.join(", ")}, updated_at = ? WHERE id = 1`,
  ).run(...values, now);
}

/**
 * Seat one participant, in the object's own vocabulary.
 *
 * The retired `_runtime_workstream_participants` view renamed nothing but
 * `joined_at`, and invented `status` and `participant_epoch` — two `NOT NULL`
 * columns the old vocabulary never carried, which its trigger filled in. With
 * the view gone the invention happens here, once, where it can be read.
 */
export function seedWorkstreamObjectParticipant(
  database: DatabaseSync,
  participant: {
    userId: string;
    participationReason?: "creator" | "explicit" | "message" | "elicitation" | "action";
    addedByUserId?: string | null;
    addedAt?: number;
    removedAt?: number | null;
  },
  now = Date.parse("2026-01-02T00:00:00.000Z"),
): void {
  const addedAt = participant.addedAt ?? now;
  const removedAt = participant.removedAt ?? null;
  database.prepare(
    `INSERT INTO participants
       (user_id, participation_reason, added_by_user_id, status, participant_epoch,
        added_at, removed_at, first_opened_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       participation_reason = excluded.participation_reason,
       added_by_user_id = excluded.added_by_user_id,
       status = excluded.status,
       added_at = excluded.added_at,
       removed_at = excluded.removed_at,
       updated_at = excluded.updated_at`,
  ).run(
    participant.userId,
    participant.participationReason ?? "explicit",
    participant.addedByUserId ?? participant.userId,
    removedAt === null ? "active" : "removed",
    addedAt,
    removedAt,
    now,
  );
}

/** The root row a fixture wrote, in the object's own columns. */
export function workstreamObjectRootRow<T extends Record<string, string | number | null>>(
  database: DatabaseSync,
  columns: string,
): T {
  return database.prepare(`SELECT ${columns} FROM workstream WHERE id = 1`).get() as T;
}

/** The seated participants a fixture wrote, oldest first. */
export function workstreamObjectParticipantRows<
  T extends Record<string, string | number | null>,
>(database: DatabaseSync, columns = "user_id, participation_reason, added_by_user_id, added_at, removed_at"): T[] {
  return database.prepare(
    `SELECT ${columns} FROM participants ORDER BY added_at, user_id`,
  ).all() as T[];
}

/**
 * Seed one tool receipt in the object's own vocabulary.
 *
 * Fixtures used to write `tool_invocations` and let the compatibility trigger
 * translate — and invent the five `NOT NULL` columns the old vocabulary never
 * carried. With the view retired there is nothing to translate, so the
 * invention happens here, once, where it can be read. Note `status`: the view
 * spelled the first two `pending` and `started`; the object has only ever
 * stored `admitted` and `executing`.
 */
export function seedToolReceipt(
  database: DatabaseSync,
  receipt: {
    id: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    status?: "admitted" | "executing" | "completed" | "failed" | "ambiguous";
    mode?: "read" | "write";
    position?: number;
    requestHash?: string;
    inputJson?: string;
    outputRef?: string | null;
    outputSummary?: string | null;
    executionPlanJson?: string | null;
    startedAt?: number | null;
    settledAt?: number | null;
    checkpointIndex?: number;
  },
): void {
  database.prepare(
    `INSERT INTO tool_effects
       (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name,
        mode, request_hash, authority_revision, status, tool_call_id, input_json,
        output_ref, output_summary, execution_plan_json, started_at, settled_at,
        checkpoint_index)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, 'runtime', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.id,
    receipt.runId,
    receipt.position ?? 0,
    `runtime:${receipt.id}`,
    receipt.toolName,
    receipt.mode ?? "read",
    receipt.requestHash ?? "hash",
    receipt.status ?? "executing",
    receipt.toolCallId,
    receipt.inputJson ?? "{}",
    receipt.outputRef ?? null,
    receipt.outputSummary ?? null,
    receipt.executionPlanJson ?? null,
    receipt.startedAt ?? null,
    receipt.settledAt ?? null,
    receipt.checkpointIndex ?? 0,
  );
}

/**
 * Seed one normalized run receipt for a test whose subject is not run
 * admission itself. The helper deliberately accepts only current object
 * vocabulary; a test cannot accidentally depend on the retired
 * `harness_runs` view's column or status translations.
 */
export function seedWorkstreamRun(
  database: DatabaseSync,
  run: {
    id: string;
    status?: "admitted" | "running" | "needs_input" | "completed" | "failed" | "cancelled";
    origin?: string;
    executionPrincipalJson?: string;
    model?: string | null;
    triggerPartId?: string | null;
    attemptId?: string | null;
    attemptEpoch?: number;
    leaseOwner?: string | null;
    leaseExpiresAt?: number | null;
    heartbeatAt?: number | null;
    substreamId?: string;
    parentRunId?: string | null;
    parentToolCallId?: string | null;
    chainRootRunId?: string | null;
    chainDepth?: number;
    delegatedTaskHash?: string | null;
    startedAt?: number;
    completedAt?: number | null;
    createdAt?: number;
  },
): void {
  const createdAt = run.createdAt ?? Date.parse("2026-01-02T00:00:00.000Z");
  const startedAt = run.startedAt ?? createdAt;
  const status = run.status ?? "running";
  const terminal = ["needs_input", "completed", "failed", "cancelled"].includes(status);
  const completedAt = run.completedAt ?? (terminal ? createdAt : null);
  const substreamId = run.substreamId ?? (run.parentToolCallId ? `run:${run.id}` : "0");
  if (substreamId !== "0") {
    database.prepare(
      `INSERT OR IGNORE INTO substreams
         (id, kind, inherit_mode, inherit_from_substream_id, inherit_fence_seq, depth,
          return_mode, audience, tool_policy, status, created_at)
       VALUES (?, 'agent', 'fork', '0', 0, 1, 'tool_result', 'system', 'read_only', 'open', ?)`,
    ).run(substreamId, createdAt);
  }
  database.prepare(
    `INSERT INTO runs
       (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
        next_action_cursor, input_fence_seq, revision, started_at,
        active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
        tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
        terminal_reason, origin, execution_principal_json, parent_run_id,
        parent_tool_call_id, chain_root_run_id, chain_depth, delegated_task_hash, model,
        trigger_part_id, legacy_attempt_id, lease_owner, lease_expires_at, heartbeat_at,
        completed_at, terminalized_at, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, 0, '', 0, 0, ?,
             0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    substreamId,
    status,
    run.attemptEpoch ?? 0,
    startedAt,
    terminal ? status : null,
    run.origin ?? "test",
    run.executionPrincipalJson ?? "{}",
    run.parentRunId ?? null,
    run.parentToolCallId ?? null,
    run.chainRootRunId ?? null,
    run.chainDepth ?? 0,
    run.delegatedTaskHash ?? null,
    run.model ?? null,
    run.triggerPartId ?? null,
    run.attemptId ?? null,
    run.leaseOwner ?? null,
    run.leaseExpiresAt ?? null,
    run.heartbeatAt ?? null,
    completedAt,
    terminal ? completedAt : null,
    createdAt,
    completedAt ?? createdAt,
  );
}

export interface RuntimeStatement {
  sql: string;
  params: Array<string | number | null>;
}

export interface RuntimeStatementResult {
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  changes: number;
}

/**
 * Execute a fixture batch against the normalized object schema. This is direct
 * test setup/inspection, not a model of an application transport: production
 * behavior is exercised through the typed object ports below.
 */
export function executeWorkstreamObjectSql(
  database: DatabaseSync,
  statements: RuntimeStatement[],
  afterStatement?: (
    database: DatabaseSync,
    statement: RuntimeStatement,
    index: number,
    statements: RuntimeStatement[],
  ) => void,
): RuntimeStatementResult[] {
  const sql = objectSqlStorage(database);
  const results: RuntimeStatementResult[] = [];
  database.exec("BEGIN");
  try {
    for (const [index, statement] of statements.entries()) {
      let cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
      try {
        cursor = sql.exec<Record<string, SqlStorageValue>>(
          statement.sql,
          ...statement.params,
        );
      } catch (error) {
        // Include the fixture statement in the diagnosis so a batch failure
        // identifies the exact normalized setup or inspection statement.
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `workstream_object_fixture_statement_failed: ${reason} :: ${statement.sql.slice(0, 300)}`,
          { cause: error },
        );
      }
      const rows = cursor.toArray() as Array<Record<string, string | number | null>>;
      results.push({
        columns: rows.length === 0 ? [] : Object.keys(rows[0]!),
        rows,
        changes: cursor.rowsWritten,
      });
      afterStatement?.(database, statement, index, statements);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return results;
}

/** Read normalized rows from an object database. */
export function workstreamObjectAll<T extends Record<string, string | number | null>>(
  database: DatabaseSync,
  sql: string,
  ...params: Array<string | number | null>
): T[] {
  return executeWorkstreamObjectSql(database, [{ sql, params }])[0]!.rows as T[];
}

/** First normalized row (or null) from an object database. */
export function workstreamObjectGet<T extends Record<string, string | number | null>>(
  database: DatabaseSync,
  sql: string,
  ...params: Array<string | number | null>
): T | null {
  return (workstreamObjectAll<T>(database, sql, ...params)[0]) ?? null;
}

/** Run one normalized fixture mutation against an object database. */
export function workstreamObjectRun(
  database: DatabaseSync,
  sql: string,
  ...params: Array<string | number | null>
): { changes: number } {
  const [result] = executeWorkstreamObjectSql(database, [{ sql, params }]);
  return { changes: result!.changes };
}

/**
 * A Terminal port backed by the test's own object database.
 *
 * The services take a `TerminalPortFactory` so this can hand them real
 * storage over `node:sqlite` running the checked-in object schema: the SQL,
 * the constraints, and the transactions are the real ones. What this cannot
 * prove is anything the runtime decides — serialization against a concurrent
 * caller, an alarm observing a committed row — which is why the Terminal
 * runtime tests live in `test-workers/` against real workerd.
 */
/**
 * The resident authority in the form an object installs it: an executor over
 * the real Terminal storage, which is what `withLocalWorkstreamAuthorities`
 * carries and what `createTerminalObjectPort` calls when it finds one.
 */
export function testTerminalOperationExecutor(objectStore: DatabaseSync): TerminalOperationExecutor {
  const storage = new WorkstreamTerminalStorage(createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql: objectSqlStorage(objectStore),
  }));
  return async (operation, args) => {
    const method = storage[operation] as (...rest: unknown[]) => unknown;
    return method.apply(storage, args) ?? null;
  };
}

export function testTerminalPortFactory(objectStore: DatabaseSync): TerminalPortFactory {
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql: objectSqlStorage(objectStore),
  });
  return createTerminalPortFactory(
    createTestEnv({}),
    new WorkstreamTerminalStorage(storage),
  );
}

export type RecordedDispatch = Record<string, unknown>;

/** A wire-shaped `WorkstreamSchema` object for fabricated product responses. */
export function testWorkstreamContract(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const at = "2026-01-02T00:00:00.000Z";
  return {
    id: "00000000-0000-4000-8000-00000000aaaa",
    workspaceId: "00000000-0000-4000-8000-00000000bbbb",
    title: "Test work stream",
    titleStatus: "settled",
    objective: "",
    emailAddress: null,
    originType: "ad_hoc",
    originLabel: null,
    createdByUserId: null,
    automationSubscriptionId: null,
    automationRunId: null,
    plannedFor: null,
    harnessStatus: "running",
    latestAttentionSequenceNumber: 1,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: at,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    scope: "workspace",
    ...overrides,
  };
}

interface SubstreamAgentsStubOptions {
  /** Every `activateLoop` payload, in order. */
  dispatches?: RecordedDispatch[];
  /** Every `publishEvent` event, in order. */
  roomEvents?: Array<Record<string, unknown>>;
  /**
   * Throw or answer a failure for a dispatch instead of recording it. Return
   * `null` to fall through to the default 200 recording behavior, so a test
   * can fail the first dispatch and admit the second.
   */
  failDispatch?: (input: RecordedDispatch) => { status: number; bodyJson: string } | null;
  /**
   * Fabricated `handleProductRequest` responses by operation name. Any
   * operation without a handler throws, naming itself, so a test cannot lean
   * on product behavior it never modeled.
   */
  product?: Record<string, (request: Record<string, unknown>) => unknown>;
  /** Additional RPC methods merged onto the stub object. */
  extra?: Record<string, unknown>;
  /**
   * When the binding is built over the regional database, the per-workstream
   * object databases it creates land here, keyed by workstream id, so a test
   * can assert object state (through {@link workstreamObjectGet}) or close
   * them. Ignored when the binding is built over an object store directly.
   */
  objectStores?: Map<string, DatabaseSync>;
}

function isWorkstreamObjectStore(database: DatabaseSync): boolean {
  return database.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workstream'`,
  ).get() !== undefined;
}

/**
 * The agent stub's identity endpoint, over one object database.
 *
 * Exported so a test with its own hand-built agent stub gets the *real*
 * `WorkstreamIdentityStorage` for these operations rather than a second model
 * of the root row. The provision's write in particular is the whole point of
 * the operation, and a double that reproduced it by hand is the one that
 * drifts. It refuses an object that is not authoritative, as the agent's
 * `objectPortRefusal` does before any operation runs.
 */
export function testIdentityOperationStub(
  database: DatabaseSync,
): (input: { operation: string; args: unknown[] }) => { status: number; bodyJson: string } {
  return (input) => {
    const authority = database.prepare(
      "SELECT authority_mode, authority_generation FROM workstream WHERE id = 1",
    ).get() as { authority_mode: string; authority_generation: number } | undefined;
    if (authority && (authority.authority_mode !== "authoritative" || authority.authority_generation <= 0)) {
      return { status: 409, bodyJson: JSON.stringify({ ok: false, error: AUTHORITY_FENCED_CODE }) };
    }
    const storage = new WorkstreamIdentityStorage(
      createCloudflareTestBinding<DurableObjectStorage>({
        getAlarm: async () => null,
        setAlarm: async () => undefined,
        transactionSync: (body: () => unknown) => body(),
        sql: objectSqlStorage(database),
      }),
    ) as unknown as Record<string, (...args: unknown[]) => unknown>;
    const value = storage[input.operation]!.apply(storage, input.args);
    return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
  };
}

/**
 * A SUBSTREAM_AGENTS binding whose typed work-stream operations execute against
 * a real object database — created by {@link testWorkstreamObjectStore} and
 * root-seeded from the request ids, one per work stream, or the given database
 * itself when it already is an object store — after the same identity and fence
 * checks the Durable Object makes. The remaining `executeRuntimeSql` method is
 * WorkspaceDO-only: it executes against the given through-0089 compatibility
 * database so focused workspace repository tests can preserve their frozen SQL
 * dialect. That is a test fixture, not current regional D1. Run dispatch is
 * recorded instead of executed. Pair with
 * {@link openWorkstreamAuthorityForTest}.
 */
/** A query fixture's already-delivered authority projection. Runtime transfer/recovery
 * is exercised in test-workers; these Node cases exercise real object SQL. */
export function seedProjectedParticipants(storage: DurableObjectStorage): void {
  const authority = new ParticipantAuthorityTransferStorage(storage);
  if (authority.currentTransferId()) return;
  const transferId = crypto.randomUUID();
  const prepared = authority.prepare(transferId);
  authority.commit(transferId);
  for (const [index, person] of prepared.participants.entries()) authority.applyProjection({
    transferId, userId: person.userId, revision: index + 1, active: true,
    reason: person.reason === "creator" ? "creator" : "explicit", addedByUserId: person.addedByUserId,
    changedAt: person.addedAt,
  });
}

export function testSubstreamAgentsBinding(
  database: DatabaseSync,
  options: SubstreamAgentsStubOptions = {},
): DurableObjectNamespace {
  const objectStoreMode = isWorkstreamObjectStore(database);
  const stores = options.objectStores ?? new Map<string, DatabaseSync>();
  /**
   * One store per conversation object: the main conversation's under the
   * work stream's own id, as every caller keyed it before conversations had
   * objects of their own, and any other conversation's under
   * `<workstreamId>:<substreamId>`, which is what a test that gives a side
   * thread its own sandbox seeds.
   */
  const storeFor = (workstreamId: string, workspaceId: string, substreamId = "0"): DatabaseSync => {
    if (objectStoreMode) {
      seedWorkstreamObjectRoot(database, { workstreamId, workspaceId });
      return database;
    }
    const key = substreamId === "0" ? workstreamId : `${workstreamId}:${substreamId}`;
    let store = stores.get(key);
    if (!store) {
      store = testWorkstreamObjectStore();
      stores.set(key, store);
    }
    seedWorkstreamObjectRoot(store, { workstreamId, workspaceId });
    return store;
  };
  const externalProductFor = (workstreamId: string, workspaceId: string) => {
    const store = storeFor(workstreamId, workspaceId);
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(),
      sql: objectSqlStorage(store),
    });
    seedProjectedParticipants(storage);
    return new WorkstreamObjectProductService(
      storage,
      new WorkstreamObjectStore(storage, "test-substream-binding", "global"),
      createTestEnv({
        DB: sqliteD1(database),
        AVALON_REGION: "global",
      }),
    );
  };
  const stub = {
    // Service tests observe admission delegation; real grants/projections and
    // retry semantics run through workerd in participant-notification.test.ts.
    admitConnectorParticipants: vi.fn(async () => ({ status: "ready" })),
    /**
     * The Terminal port's counterpart, run against the same object database
     * the SQL port uses. Real storage, real schema, real constraints — the
     * one thing standing in is the transport, because a Worker-to-object
     * round trip is what `test-workers/` exists to exercise.
     */
    executeTerminalOperation: vi.fn((input: {
      workspaceId: string;
      workstreamId: string;
      substreamId?: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId, input.substreamId);
      const storage = createCloudflareTestBinding<DurableObjectStorage>({
        getAlarm: async () => null,
        setAlarm: async () => undefined,
        transactionSync: (body: () => unknown) => body(),
        sql: objectSqlStorage(store),
      });
      const terminal = new WorkstreamTerminalStorage(storage) as unknown as
        Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = terminal[input.operation]!.apply(terminal, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "terminal_operation_failed",
          }),
        };
      }
    }),
    /**
     * The tool-receipt port's counterpart, on the same object database.
     *
     * Same shape and same reasoning as `executeTerminalOperation` above: real
     * storage, real schema, real constraints, with only the transport standing
     * in. A lost lease comes back as a 200 carrying `ownership_lost`, because
     * that is an ordinary end to a run rather than a fault — a stub that threw
     * for it would let a test pass against error handling production never
     * reaches.
     */
    executeToolReceiptOperation: vi.fn((input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const storage = new WorkstreamToolReceiptStorage(
        createCloudflareTestBinding<DurableObjectStorage>({
          getAlarm: async () => null,
          setAlarm: async () => undefined,
          transactionSync: (body: () => unknown) => body(),
          sql: objectSqlStorage(store),
        }),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = storage[input.operation]!.apply(storage, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "tool_receipt_operation_failed",
          }),
        };
      }
    }),
    /**
     * The harness-run port's counterpart, on the same object database.
     *
     * Same shape and reasoning as its siblings. Refusals — a lost lease, a
     * stale admission, a run that is already terminal — come back as a 200
     * carrying the named outcome, because every one of them is an ordinary
     * answer this authority is designed to give rather than a fault.
     */
    executeHarnessRunOperation: vi.fn(async (input: {
      workspaceId: string;
      workstreamId: string;
      substreamId?: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId, input.substreamId);
      const storage = new WorkstreamHarnessRunStorage(
        createCloudflareTestBinding<DurableObjectStorage>({
          getAlarm: async () => null,
          setAlarm: async () => undefined,
          transactionSync: (body: () => unknown) => body(),
          sql: objectSqlStorage(store),
        }),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = await storage[input.operation]!.apply(storage, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "harness_run_operation_failed",
          }),
        };
      }
    }),
    /**
     * The transcript port's counterpart, on the same object database.
     *
     * Same shape and reasoning as its siblings. A replayed append comes back as
     * a 200 carrying `replayed`, because a redelivery is the ordinary case for
     * every transcript write in this product rather than a fault.
     */
    executeMessageOperation: vi.fn(async (input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const storage = new WorkstreamMessageStorage(
        createCloudflareTestBinding<DurableObjectStorage>({
          getAlarm: async () => null,
          setAlarm: async () => undefined,
          transactionSync: (body: () => unknown) => body(),
          sql: objectSqlStorage(store),
        }),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = await storage[input.operation]!.apply(storage, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "message_operation_failed",
          }),
        };
      }
    }),
    /**
     * The resource-attachment port's counterpart, on the same object database.
     *
     * Same shape and reasoning as its siblings: real storage, real schema, real
     * constraints, with only the transport standing in.
     */
    executeResourceOperation: vi.fn((input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const storage = new WorkstreamResourceStorage(
        createCloudflareTestBinding<DurableObjectStorage>({
          getAlarm: async () => null,
          setAlarm: async () => undefined,
          transactionSync: (body: () => unknown) => body(),
          sql: objectSqlStorage(store),
        }),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = storage[input.operation]!.apply(storage, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "resource_operation_failed",
          }),
        };
      }
    }),
    /**
     * The scheduling port's counterpart, on the same object database.
     *
     * Same shape and reasoning as the two above. A refused claim comes back as
     * a 200 carrying its own outcome, because a wake-up someone else took is an
     * ordinary answer rather than a fault.
     */
    executeSchedulingOperation: vi.fn(async (input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const storage = new WorkstreamSchedulingStorage(
        createCloudflareTestBinding<DurableObjectStorage>({
          getAlarm: async () => null,
          setAlarm: async () => undefined,
          transactionSync: (body: () => unknown) => body(),
          sql: objectSqlStorage(store),
        }),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = await storage[input.operation]!.apply(storage, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "scheduling_operation_failed",
          }),
        };
      }
    }),
    executeRuntimeSql: vi.fn((input: {
      workspaceId: string;
      statements: RuntimeStatement[];
    }) => {
      if (objectStoreMode) {
        throw new Error("workspace runtime SQL routed to an object-store-backed binding");
      }
      // Workspace authority: those D1 tables were kept, so the migrated
      // regional database is still the store the WorkspaceDO port serves.
      const results: RuntimeStatementResult[] = [];
      database.exec("BEGIN");
      try {
        for (const { sql, params } of input.statements) {
          const statement = database.prepare(sql);
          if (/^\s*(?:SELECT|WITH)/iu.test(sql)) {
            const rows = statement.all(...params) as Array<Record<string, string | number | null>>;
            results.push({
              columns: rows.length > 0 ? Object.keys(rows[0]!) : [],
              rows,
              changes: 0,
            });
          } else if (/\bRETURNING\b/iu.test(sql)) {
            const rows = statement.all(...params) as Array<Record<string, string | number | null>>;
            results.push({
              columns: rows.length > 0 ? Object.keys(rows[0]!) : [],
              rows,
              changes: rows.length,
            });
          } else {
            try {
              const run = statement.run(...params);
              results.push({ columns: [], rows: [], changes: Number(run.changes) });
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              throw new Error(
                `workspace_runtime_statement_failed: ${reason} :: ${sql.slice(0, 300)}`,
                { cause: error },
              );
            }
          }
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { status: 200, bodyJson: JSON.stringify({ results }) };
    }),
    readerAudience: vi.fn((input: { workspaceId: string; workstreamId: string }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const root = store.prepare(
        `SELECT scope FROM workstream WHERE id = 1`,
      ).get() as { scope: "personal" | "workspace" } | undefined;
      if (!root) return null;
      if (root.scope === "workspace") return { scope: "workspace" as const };
      const participants = store.prepare(
        `SELECT user_id FROM participants WHERE status = 'active' ORDER BY user_id`,
      ).all() as Array<{ user_id: string }>;
      return {
        scope: "personal" as const,
        userIds: participants.map((participant) => participant.user_id),
      };
    }),
    activateLoop: vi.fn((input: RecordedDispatch) => {
      const failure = options.failDispatch?.(input);
      if (failure) return failure;
      options.dispatches?.push(input);
      return { status: 200, bodyJson: "{}" };
    }),
    admitExternalMessage: vi.fn(async (input: {
      workspaceId: string;
      workstreamId: string;
    } & Record<string, unknown>) => {
      try {
        const result = await externalProductFor(input.workstreamId, input.workspaceId)
          .admitExternalMessage(input as Parameters<
            WorkstreamObjectProductService["admitExternalMessage"]
          >[0]);
        if (result.activationRequest) options.dispatches?.push({ ...result.activationRequest });
        return {
          status: 200,
          bodyJson: JSON.stringify({
            turn: result.turn,
            deliveryState: result.deliveryState,
          }),
        };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "external_message_admission_failed",
          }),
        };
      }
    }),
    answerExternalElicitation: vi.fn(async (input: {
      workspaceId: string;
      workstreamId: string;
    } & Record<string, unknown>) => {
      try {
        const result = await externalProductFor(input.workstreamId, input.workspaceId)
          .answerExternalElicitation(input as Parameters<
            WorkstreamObjectProductService["answerExternalElicitation"]
          >[0]);
        if (result.activationRequest) options.dispatches?.push({ ...result.activationRequest });
        return {
          status: 200,
          bodyJson: JSON.stringify({
            turn: result.turn,
            deliveryState: result.deliveryState,
          }),
        };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "external_elicitation_answer_failed",
          }),
        };
      }
    }),
    publishEvent: vi.fn((input: { event: Record<string, unknown> }) => {
      options.roomEvents?.push(input.event);
      return { status: 204, bodyJson: "null" };
    }),
    bootstrapRuntime: vi.fn((input: { workspaceId: string; parentId: string }) => {
      // Production's bootstrap opens the object and writes its identity root;
      // seeding here is that same admission, so a creation flow's first routed
      // statement finds the root the way it would in the real object. The
      // request names the conversation's parent rather than a work stream, so
      // the store this double keys on is the parent's.
      const store = storeFor(input.parentId, input.workspaceId);
      // And it stamps the reason code, as `bootstrapRuntimeAuthority` does.
      // `provisionWorkstream` keys its replay guard on that value, so a double
      // that left the shared fixture's `seeded` in place would make every
      // provision look like a replay and write nothing.
      store.prepare(
        `UPDATE workstream
            SET authority_mode = 'authoritative', exact_state = 'idle',
                state_reason_code = 'runtime_bootstrap'
          WHERE id = 1 AND state_reason_code = 'seeded'`,
      ).run();
      return { status: 200, bodyJson: "{}" };
    }),
    executeIdentityOperation: vi.fn((input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => testIdentityOperationStub(storeFor(input.workstreamId, input.workspaceId))(input)),
    refreshTimerAlarm: vi.fn(() => ({ status: 200, bodyJson: "{}" })),
    handleProductRequest: vi.fn((request: { operation: string } & Record<string, unknown>) => {
      const handler = options.product?.[request.operation];
      if (!handler) throw new Error(`unstubbed product operation: ${request.operation}`);
      return { status: 200, bodyJson: JSON.stringify(handler(request)) };
    }),
    ...options.extra,
  };
  const binding: DurableObjectNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
    idFromName: vi.fn((name: string) => createTestDurableObjectId(name)),
    get: vi.fn(() => stub),
    jurisdiction: vi.fn((): DurableObjectNamespace => binding),
  });
  return binding;
}

/**
 * One in-isolate port over a real storage instance, for any of the authorities.
 *
 * The Node suite's stand-in for an `/internal/*` round trip: the real storage
 * class over the real object schema, so every statement and every fence is
 * exercised. What the *runtime* decides — that the operation is atomic against
 * a concurrent caller, that a lease cannot lapse mid-operation — is proved in
 * `test-workers/` instead.
 *
 * One helper rather than three, matching `createObjectPort`, which the three
 * production ports collapsed onto for the same reason. The three copies this
 * replaces had all drifted from production in the same way: none applied the
 * `?? null` coalesce the real seam applies, so a method returning `undefined` —
 * `wakeup`, `oldestOpenElicitation`, `descriptionRefreshState`, and
 * `compactionCheckpoint` —
 * answered the Node suite differently from the wire, where JSON has no
 * `undefined` and an absent `value` arrives as `null`.
 */
function testObjectPort<TStorage, TOperation extends keyof TStorage & string, TPort>(
  storage: TStorage,
  operations: readonly TOperation[],
): TPort {
  return Object.fromEntries(
    operations.map((operation) => [
      operation,
      async (...args: unknown[]) =>
        (storage[operation] as (...rest: unknown[]) => unknown).apply(storage, args) ?? null,
    ]),
  ) as TPort;
}

/**
 * A tool-receipt port backed by the same in-memory object database.
 *
 * Takes the two staging hooks the others do not need: receipt operations read
 * their fences and write their rows in one transaction, so a race that used to
 * fit between two D1 batches has to be staged from inside it.
 */
export function testToolReceiptPort(
  database: DatabaseSync,
  /**
   * Run inside `transactionSync`, immediately before the operation's body.
   *
   * The only way for a test to land competing state at the last instant an
   * operation could still observe it.
   */
  beforeTransaction?: () => void,
  /**
   * Run after each statement an operation executes, with that statement's SQL.
   *
   * The counterpart to `beforeTransaction` for the other half of an operation:
   * competing state that lands *after* a decision has been read, to prove the
   * decision is not re-derived from a source that has since moved.
   */
  afterStatement?: (sql: string) => void,
): ToolReceiptObjectPort {
  const objectSql = objectSqlStorage(database);
  const sql = afterStatement
    ? new Proxy(objectSql, {
      get(target, property, receiver) {
        if (property !== "exec") return Reflect.get(target, property, receiver) as unknown;
        return (statement: string, ...values: unknown[]) => {
          const result = (target.exec as (...rest: unknown[]) => unknown)(statement, ...values);
          afterStatement(statement);
          return result;
        };
      },
    })
    : objectSql;
  return testObjectPort<WorkstreamToolReceiptStorage, ToolReceiptOperation, ToolReceiptObjectPort>(
    new WorkstreamToolReceiptStorage(
      createCloudflareTestBinding<DurableObjectStorage>({
        getAlarm: async () => null,
        setAlarm: async () => undefined,
        transactionSync: (body: () => unknown) => {
          beforeTransaction?.();
          return body();
        },
        sql,
      }),
    ),
    TOOL_RECEIPT_OPERATIONS,
  );
}

/** A storage binding over one in-memory object database, with no staging hooks. */
function plainBinding(database: DatabaseSync): DurableObjectStorage {
  return createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql: objectSqlStorage(database),
  });
}

/**
 * A transcript port over a real storage instance in this isolate.
 *
 * The seam the other ports take. What the runtime decides for this one — that
 * an append and the directory projection showing its preview are one commit —
 * belongs in `test-workers/`.
 */
export function testMessagePort(database: DatabaseSync): MessageObjectPort {
  const storage = new WorkstreamMessageStorage(
    createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(),
      sql: objectSqlStorage(database),
    }),
  );
  return Object.fromEntries(
    MESSAGE_OPERATIONS.map((operation) => [
      operation,
      async (...args: unknown[]) =>
        (storage[operation] as (...rest: unknown[]) => unknown).apply(storage, args),
    ]),
  ) as MessageObjectPort;
}

/**
 * A scheduling port over a real storage instance in this isolate.
 *
 * One more use than the others have: the owning object fires its own wake-up
 * alarms, so this is also what a test uses to stand where the object stands,
 * with its storage in hand rather than a stub addressed to itself.
 */
export function testSchedulingPort(database: DatabaseSync): SchedulingObjectPort {
  return testObjectPort<WorkstreamSchedulingStorage, SchedulingOperation, SchedulingObjectPort>(
    new WorkstreamSchedulingStorage(plainBinding(database)),
    SCHEDULING_OPERATIONS,
  );
}

export function testTranscriptPort(database: DatabaseSync): TranscriptObjectPort {
  return testObjectPort<WorkstreamTranscriptStorage, TranscriptOperation, TranscriptObjectPort>(
    new WorkstreamTranscriptStorage(plainBinding(database)),
    TRANSCRIPT_OPERATIONS,
  );
}

/**
 * A resource-attachment port over a real storage instance in this isolate.
 *
 * On the shared helper like its three siblings — this arrived as a fifth
 * hand-written copy, from a branch written before they were folded together.
 */
export function testResourcePort(database: DatabaseSync): ResourceObjectPort {
  return testObjectPort<WorkstreamResourceStorage, ResourceOperation, ResourceObjectPort>(
    new WorkstreamResourceStorage(plainBinding(database)),
    RESOURCE_OPERATIONS,
  );
}

/** A harness-run storage authority over the real object database in this isolate. */
export function testHarnessRunStorage(
  database: DatabaseSync,
  /**
   * Run inside `transactionSync`, immediately before the operation's body.
   *
   * `testToolReceiptPort`'s seam, for the reason it exists there: a claim, a
   * terminalization and a reap each read their fence and write their rows in
   * one transaction, so a race that used to be staged between two statements of
   * a D1 batch has to be staged from here instead.
   */
  beforeTransaction?: () => void,
): WorkstreamHarnessRunStorage {
  return new WorkstreamHarnessRunStorage(
    createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => {
        beforeTransaction?.();
        return body();
      },
      sql: objectSqlStorage(database),
    }),
  );
}

/** A harness-run RPC port over a real storage instance in this isolate. */
export function testHarnessRunPort(
  database: DatabaseSync,
  beforeTransaction?: () => void,
): HarnessRunObjectPort {
  const storage = testHarnessRunStorage(database, beforeTransaction);
  return Object.fromEntries(
    HARNESS_RUN_OPERATIONS.map((operation) => [
      operation,
      async (...args: unknown[]) =>
        (storage[operation] as (...rest: unknown[]) => unknown).apply(storage, args),
    ]),
  ) as HarnessRunObjectPort;
}

/** The same port as a factory, for a caller that takes one. */
export function testHarnessRunPortFactory(database: DatabaseSync): (
  workspaceId: string,
  workstreamId: string,
) => HarnessRunObjectPort {
  const port = testHarnessRunPort(database);
  return () => port;
}

/**
 * One conversation's resource links over its object database, as every
 * visibility read takes them. `channel` is the Channel's Main object, asked
 * only when `database` is a Breakout's.
 */
export function testConversationResourceLinks(
  database: DatabaseSync,
  channel?: DatabaseSync,
): ConversationResourceLinks {
  return conversationResourceLinks(testResourcePort(database), () => {
    if (!channel) throw new Error("This conversation inherited links from a Channel the test did not provide");
    return testResourcePort(channel);
  });
}

/** The same port as a factory, for a caller that takes one. */
export function testResourcePortFactory(database: DatabaseSync): (
  workspaceId: string,
  workstreamId: string,
) => ResourceObjectPort {
  const port = testResourcePort(database);
  return () => port;
}
