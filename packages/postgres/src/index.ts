import postgres, { type Sql } from "postgres";
import { z } from "zod";

export type DatabaseRole =
  | "global_router"
  | "regional_router"
  | "workflow_runner"
  | "queue_runner";

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export interface PostgresConnectionConfig {
  connectionString: string;
  role: DatabaseRole;
  ssl?: boolean;
  applicationName?: string;
}

export interface RoutingCommand {
  commandId: string;
  workspaceId: string;
  routeEpoch: number;
  targetShardId: string;
  operationKind: string;
  payloadVersion: number;
  payload: JsonValue;
  payloadHash: Uint8Array;
  attemptNo: number;
}

export interface QueueMessage {
  messageId: number;
  readCount: number;
  enqueuedAt: Date;
  visibleAt: Date;
  message: JsonValue;
}

export interface MigrationJobClaim {
  jobId: string;
  leaseToken: string;
  campaignPauseEpoch: number;
  workspaceId?: string;
  targetKind: string;
  targetStart?: string;
  targetEnd?: string;
  expectedSourceRevision?: number;
  attempts: number;
}

export interface OutputCheckpoint {
  runId: string;
  attemptId: string;
  expectedRevision: number;
  expectedByteOffset: number;
  firstFrameSeq: number;
  throughFrameSeq: number;
  delta: string;
  tokenEstimateThrough: number;
  prefixHash: Uint8Array;
  providerCursor?: JsonValue;
  previousBatches?: JsonValue[];
}

export interface MaterializedRunPart {
  id: string;
  seq: number;
  ordinal_in_turn: number;
  turn_id: string;
  role: "system" | "user" | "assistant" | "tool";
  kind: string;
  text?: string;
  content_ref_id?: string;
  structured_payload?: JsonValue;
  provider_call_id?: string;
  related_part_id?: string;
  content_hash: string;
}

export interface MaterializedRun {
  version: 1;
  run_id: string;
  workspace_id: string;
  workstream_id: string;
  substream_id: string;
  run_revision: number;
  control_revision: number;
  workspace_access_revision: number;
  workstream_access_revision: number;
  substream_access_revision: number;
  scope_revision: number;
  model_provider: string;
  model_name: string;
  execution_principal_kind: "user" | "workspace";
  execution_principal_id: string;
  provider_config_revision: number;
  compaction: JsonValue;
  parts: MaterializedRunPart[];
}

export type RunOutcome =
  | "completed"
  | "waiting_user"
  | "waiting_event"
  | "waiting_provider"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface WorkflowWakeDescriptor {
  run_id: string;
  workflow_instance_id: string;
  expected_run_revision: number;
  state: string;
  signals: Array<{
    signal_id: string;
    control_revision: number;
    signal_kind: string;
  }>;
}

export interface GlobalCommandReceipt {
  commandId: string;
  attemptNo: number;
  workspaceId: string;
  routeEpoch: number;
  targetShardId: string;
  regionalReceiptId: string;
  regionalState: string;
  responseHash: Uint8Array;
}

export interface RegionalGlobalCommand {
  commandId: string;
  workspaceId: string;
  routeEpoch: number;
  localShardId: string;
  regionKey: string;
  operationKind: string;
  payloadHash: Uint8Array;
  sourceClosureCursor?: string;
  sourceClosureHash?: Uint8Array;
}

interface ClaimRoutingRow {
  command_id: string;
  workspace_id: string;
  route_epoch: string | number;
  target_shard_id: string;
  operation_kind: string;
  payload_version: number;
  payload: JsonValue;
  payload_hash: Uint8Array;
  attempt_no: number;
}

interface QueueMessageRow {
  message_id: string | number;
  read_count: number;
  enqueued_at: Date;
  visible_at: Date;
  message: JsonValue;
}

interface RunSignalRow {
  [key: string]: unknown;
}

interface MigrationJobClaimRow {
  job_id: string;
  lease_token: string;
  campaign_pause_epoch: string | number;
  workspace_id: string | null;
  target_kind: string;
  target_start: string | null;
  target_end: string | null;
  expected_source_revision: string | number | null;
  attempts: number;
}

const WorkflowWakeDescriptorSchema = z.object({
  run_id: z.string().uuid(),
  workflow_instance_id: z.string().min(1),
  expected_run_revision: z.coerce.number().int().positive(),
  state: z.string(),
  signals: z.array(z.object({
    signal_id: z.string().uuid(),
    control_revision: z.coerce.number().int().positive(),
    signal_kind: z.string(),
  })),
});

const MaterializedRunSchema = z.object({
  version: z.literal(1),
  run_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  workstream_id: z.string().uuid(),
  substream_id: z.string().uuid(),
  run_revision: z.coerce.number().int().positive(),
  control_revision: z.coerce.number().int().positive(),
  workspace_access_revision: z.coerce.number().int().positive(),
  workstream_access_revision: z.coerce.number().int().positive(),
  substream_access_revision: z.coerce.number().int().positive(),
  scope_revision: z.coerce.number().int().positive(),
  model_provider: z.string().min(1),
  model_name: z.string().min(1),
  execution_principal_kind: z.enum(["user", "workspace"]),
  execution_principal_id: z.string().uuid(),
  provider_config_revision: z.coerce.number().int().positive(),
  compaction: z.unknown(),
  parts: z.array(z.object({
    id: z.string().uuid(),
    seq: z.coerce.number().int().positive(),
    ordinal_in_turn: z.coerce.number().int().nonnegative(),
    turn_id: z.string().uuid(),
    role: z.enum(["system", "user", "assistant", "tool"]),
    kind: z.string().min(1),
    text: z.string().optional(),
    content_ref_id: z.string().uuid().optional(),
    structured_payload: z.unknown().optional(),
    provider_call_id: z.string().optional(),
    related_part_id: z.string().uuid().optional(),
    content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  })),
});

function requiredString(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label}_required`);
  return trimmed;
}

function safeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label}_outside_safe_integer_range`);
  return parsed;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}_invalid`);
  }
  return value as Record<string, unknown>;
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      jsonValue(item, `${label}.${key}`),
    ]));
  }
  throw new Error(`${label}_invalid_json`);
}

export function assertTransactionPoolerUrl(connectionString: string): URL {
  const url = new URL(requiredString(connectionString, "postgres_connection_string"));
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("postgres_connection_string_protocol_invalid");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.port !== "6543") {
    throw new Error("postgres_connection_string_must_use_transaction_pooler");
  }
  if (url.username.length === 0 || url.password.length === 0) {
    throw new Error("postgres_connection_string_credentials_required");
  }
  return url;
}

export function uuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class AvalonPostgresClient {
  readonly #sql: Sql;
  readonly role: DatabaseRole;

  constructor(config: PostgresConnectionConfig) {
    assertTransactionPoolerUrl(config.connectionString);
    this.role = config.role;
    this.#sql = postgres(config.connectionString, {
      connection: { application_name: config.applicationName ?? `avalon-${config.role}` },
      connect_timeout: 10,
      idle_timeout: 5,
      max: 1,
      max_lifetime: 60 * 10,
      prepare: false,
      ssl: config.ssl === false ? false : "require",
      transform: { undefined: null },
    });
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async health(): Promise<{ databaseTime: Date; role: string }> {
    const rows = await this.#sql<{ database_time: Date; role: string }[]>`
      select now() as database_time, current_user as role
    `;
    const row = rows[0];
    if (!row) throw new Error("postgres_health_empty");
    return { databaseTime: row.database_time, role: row.role };
  }

  async claimRoutingCommands(workflowId: string, limit = 32): Promise<RoutingCommand[]> {
    this.#requireRole("global_router");
    const rows = await this.#sql<ClaimRoutingRow[]>`
      select * from avalon_private.claim_routing_commands(${workflowId}, ${limit})
    `;
    return rows.map((row) => ({
      commandId: row.command_id,
      workspaceId: row.workspace_id,
      routeEpoch: safeInteger(row.route_epoch, "route_epoch"),
      targetShardId: row.target_shard_id,
      operationKind: row.operation_kind,
      payloadVersion: row.payload_version,
      payload: row.payload,
      payloadHash: row.payload_hash,
      attemptNo: row.attempt_no,
    }));
  }

  async acknowledgeRoutingCommand(receipt: GlobalCommandReceipt): Promise<void> {
    this.#requireRole("global_router");
    await this.#sql`
      select avalon_private.acknowledge_routing_command(
        ${receipt.commandId}::uuid,
        ${receipt.attemptNo},
        ${receipt.workspaceId}::uuid,
        ${receipt.routeEpoch},
        ${receipt.targetShardId},
        ${receipt.regionalReceiptId}::uuid,
        ${receipt.regionalState},
        ${receipt.responseHash}::bytea
      )
    `;
  }

  async applyGlobalCommand(command: RegionalGlobalCommand): Promise<{
    receiptId: string;
    resultState: string;
    resultHash: Uint8Array;
  }> {
    this.#requireRole("regional_router");
    const rows = await this.#sql<{
      receipt_id: string;
      result_state: string;
      result_hash: Uint8Array;
    }[]>`
      select * from avalon_private.apply_global_workspace_command(
        ${command.commandId}::uuid,
        ${command.workspaceId}::uuid,
        ${command.routeEpoch},
        ${command.localShardId},
        ${command.regionKey},
        ${command.operationKind},
        ${command.payloadHash}::bytea,
        ${command.sourceClosureCursor ?? null},
        ${command.sourceClosureHash ?? null}::bytea
      )
    `;
    const row = rows[0];
    if (!row) throw new Error("regional_command_receipt_missing");
    return {
      receiptId: row.receipt_id,
      resultState: row.result_state,
      resultHash: row.result_hash,
    };
  }

  async workflowWakeDescriptor(input: {
    workspaceId: string;
    workstreamId: string;
    runId: string;
  }): Promise<WorkflowWakeDescriptor> {
    this.#requireRole("regional_router");
    const rows = await this.#sql<{ value: unknown }[]>`
      select avalon_private.regional_workflow_wake_descriptor(
        ${input.workspaceId}::uuid,
        ${input.workstreamId}::uuid,
        ${input.runId}::uuid
      ) as value
    `;
    const value: WorkflowWakeDescriptor = WorkflowWakeDescriptorSchema.parse(rows[0]?.value);
    if (value.run_id !== input.runId || !Array.isArray(value.signals)) {
      throw new Error("workflow_wake_descriptor_contract_invalid");
    }
    return value;
  }

  async linkPlatformIdentity(input: {
    authUserId: string;
    issuer: string;
    subject: string;
    platformUserId: string;
    accountEpoch: number;
  }): Promise<void> {
    this.#requireRole("regional_router");
    await this.#sql`
      select avalon_private.link_platform_identity(
        ${input.authUserId}::uuid,
        ${input.issuer},
        ${input.subject},
        ${input.platformUserId}::uuid,
        ${input.accountEpoch}
      )
    `;
  }

  async claimRun(input: {
    runId: string;
    expectedRunRevision: number;
    workflowInstanceId: string;
  }): Promise<unknown> {
    this.#requireRole("workflow_runner");
    const rows = await this.#sql<{ value: unknown }[]>`
      select avalon_private.workflow_claim_run(
        ${input.runId}::uuid,
        ${input.expectedRunRevision},
        ${input.workflowInstanceId}
      ) as value
    `;
    return rows[0]?.value;
  }

  async beginAction(input: {
    runId: string;
    expectedControlRevision: number;
    actionKind: "model" | "tool" | "terminal" | "wait" | "materialize" | "finalize";
    operationId: string;
  }): Promise<{ actionId: string; actionNo: number; controlRevision: number }> {
    this.#requireRole("workflow_runner");
    const rows = await this.#sql<{
      action_id: string;
      action_no: number;
      control_revision: string | number;
    }[]>`
      select * from avalon_private.workflow_begin_action(
        ${input.runId}::uuid,
        ${input.expectedControlRevision},
        ${input.actionKind},
        ${input.operationId}
      )
    `;
    const row = rows[0];
    if (!row) throw new Error("workflow_action_missing");
    return {
      actionId: row.action_id,
      actionNo: row.action_no,
      controlRevision: safeInteger(row.control_revision, "control_revision"),
    };
  }

  async materializeRun(runId: string, expectedControlRevision: number): Promise<MaterializedRun> {
    this.#requireRole("workflow_runner");
    const rows = await this.#sql<{ value: unknown }[]>`
      select avalon_private.workflow_materialize_run(
        ${runId}::uuid, ${expectedControlRevision}
      ) as value
    `;
    const parsed = MaterializedRunSchema.parse(rows[0]?.value);
    const value: MaterializedRun = {
      ...parsed,
      compaction: jsonValue(parsed.compaction, "materialized_run.compaction"),
      parts: parsed.parts.map((part) => ({
        id: part.id,
        seq: part.seq,
        ordinal_in_turn: part.ordinal_in_turn,
        turn_id: part.turn_id,
        role: part.role,
        kind: part.kind,
        content_hash: part.content_hash,
        ...(part.text === undefined ? {} : { text: part.text }),
        ...(part.content_ref_id === undefined ? {} : { content_ref_id: part.content_ref_id }),
        ...(part.structured_payload === undefined
          ? {}
          : { structured_payload: jsonValue(part.structured_payload, `materialized_run.parts.${part.id}`) }),
        ...(part.provider_call_id === undefined ? {} : { provider_call_id: part.provider_call_id }),
        ...(part.related_part_id === undefined ? {} : { related_part_id: part.related_part_id }),
      })),
    };
    if (value.version !== 1 || value.run_id !== runId || !Array.isArray(value.parts)) {
      throw new Error("materialized_run_contract_invalid");
    }
    return value;
  }

  async finishRun(input: {
    runId: string;
    expectedControlRevision: number;
    outcome: RunOutcome;
    terminalReason?: string;
    errorClass?: string;
  }): Promise<Record<string, unknown>> {
    this.#requireRole("workflow_runner");
    const rows = await this.#sql<{ value: unknown }[]>`
      select avalon_private.workflow_finish_run(
        ${input.runId}::uuid,
        ${input.expectedControlRevision},
        ${input.outcome},
        ${input.terminalReason ?? null},
        ${input.errorClass ?? null}
      ) as value
    `;
    return objectValue(rows[0]?.value, "run_finish_receipt");
  }

  async recordRunProgress(input: {
    runId: string;
    expectedControlRevision: number;
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
  }): Promise<void> {
    this.#requireRole("workflow_runner");
    await this.#sql`
      select avalon_private.workflow_record_progress(
        ${input.runId}::uuid,
        ${input.expectedControlRevision},
        ${input.inputTokens},
        ${input.outputTokens},
        ${input.elapsedMs}
      )
    `;
  }

  async beginOutputAttempt(input: {
    runId: string;
    actionId: string;
    expectedControlRevision: number;
    attemptId: string;
    partId: string;
    expiresAt: Date;
  }): Promise<{ turnId: string; attemptId: string; partId: string }> {
    this.#requireRole("workflow_runner");
    const rows = await this.#sql<{
      turn_id: string;
      attempt_id: string;
      part_id: string;
    }[]>`
      select * from avalon_private.workflow_begin_output_attempt(
        ${input.runId}::uuid,
        ${input.actionId}::uuid,
        ${input.expectedControlRevision},
        ${input.attemptId}::uuid,
        ${input.partId}::uuid,
        ${input.expiresAt}
      )
    `;
    const row = rows[0];
    if (!row) throw new Error("output_attempt_missing");
    return { turnId: row.turn_id, attemptId: row.attempt_id, partId: row.part_id };
  }

  async beginToolEffect(input: {
    runId: string;
    actionId: string;
    expectedControlRevision: number;
    effectKind: string;
    effectKey: string;
    operationId: string;
    requestHash: Uint8Array;
  }): Promise<Record<string, unknown>> {
    this.#requireRole("workflow_runner");
    const rows = await this.#sql<{ value: unknown }[]>`
      select avalon_private.workflow_begin_tool_effect(
        ${input.runId}::uuid,
        ${input.actionId}::uuid,
        ${input.expectedControlRevision},
        ${input.effectKind},
        ${input.effectKey},
        ${input.operationId},
        ${input.requestHash}::bytea
      ) as value
    `;
    return objectValue(rows[0]?.value, "tool_effect_receipt");
  }

  async settleToolEffect(input: {
    effectId: string;
    state: "succeeded" | "failed" | "response_uncertain";
    providerReference?: string;
    responseHash?: Uint8Array;
  }): Promise<Record<string, unknown>> {
    this.#requireRole("workflow_runner");
    const rows = await this.#sql<{ value: unknown }[]>`
      select avalon_private.workflow_settle_tool_effect(
        ${input.effectId}::uuid,
        ${input.state},
        ${input.providerReference ?? null},
        ${input.responseHash ?? null}::bytea
      ) as value
    `;
    return objectValue(rows[0]?.value, "tool_effect_settlement");
  }

  async commitToolExchange(input: {
    runId: string;
    actionId: string;
    expectedControlRevision: number;
    providerCallId: string;
    toolName: string;
    pluginId: string;
    toolInput: JsonValue;
    toolResult: JsonValue;
    succeeded: boolean;
  }): Promise<Record<string, unknown>> {
    this.#requireRole("workflow_runner");
    const rows = await this.#sql<{ value: unknown }[]>`
      select avalon_private.workflow_commit_tool_exchange(
        ${input.runId}::uuid,
        ${input.actionId}::uuid,
        ${input.expectedControlRevision},
        ${input.providerCallId},
        ${input.toolName},
        ${input.pluginId},
        ${this.#sql.json(input.toolInput)}::jsonb,
        ${this.#sql.json(input.toolResult)}::jsonb,
        ${input.succeeded}
      ) as value
    `;
    return objectValue(rows[0]?.value, "tool_exchange_receipt");
  }

  async supersedeOutput(input: {
    runId: string;
    attemptId: string;
    expectedAttemptControlRevision: number;
    supersedeAction?: boolean;
  }): Promise<boolean> {
    this.#requireRole("workflow_runner");
    const rows = await this.#sql<{ superseded: boolean }[]>`
      select avalon_private.workflow_supersede_output(
        ${input.runId}::uuid,
        ${input.attemptId}::uuid,
        ${input.expectedAttemptControlRevision},
        ${input.supersedeAction ?? true}
      ) as superseded
    `;
    return rows[0]?.superseded ?? false;
  }

  async checkpointOutput(input: OutputCheckpoint): Promise<unknown> {
    this.#requireRole("workflow_runner");
    const rows = await this.#sql<{ value: unknown }[]>`
      select avalon_private.checkpoint_active_output(
        ${input.runId}::uuid,
        ${input.attemptId}::uuid,
        ${input.expectedRevision},
        ${input.expectedByteOffset},
        ${input.firstFrameSeq},
        ${input.throughFrameSeq},
        ${input.delta},
        ${input.tokenEstimateThrough},
        ${input.prefixHash}::bytea,
        ${this.#sql.json(input.providerCursor ?? null)}::jsonb,
        ${this.#sql.json(input.previousBatches ?? [])}::jsonb
      ) as value
    `;
    return rows[0]?.value;
  }

  async finalizeOutput(input: {
    runId: string;
    attemptId: string;
    expectedRevision: number;
    expectedByteOffset: number;
    finalContentHash: Uint8Array;
    terminalContentRefId?: string;
    terminalRun: boolean;
  }): Promise<string> {
    this.#requireRole("workflow_runner");
    const rows = await this.#sql<{ part_id: string }[]>`
      select avalon_private.finalize_active_output(
        ${input.runId}::uuid,
        ${input.attemptId}::uuid,
        ${input.expectedRevision},
        ${input.expectedByteOffset},
        ${input.finalContentHash}::bytea,
        ${input.terminalContentRefId ?? null}::uuid,
        ${input.terminalRun}
      ) as part_id
    `;
    const partId = rows[0]?.part_id;
    if (!partId) throw new Error("finalized_output_part_missing");
    return partId;
  }

  async pendingSignals(runId: string, after?: Date): Promise<RunSignalRow[]> {
    this.#requireRole("workflow_runner");
    return this.#sql<RunSignalRow[]>`
      select * from avalon_private.workflow_pending_signals(
        ${runId}::uuid,
        ${after ?? new Date(0)}
      )
    `;
  }

  async observeSignal(runId: string, signalId: string, controlRevision: number): Promise<void> {
    this.#requireRole("workflow_runner");
    await this.#sql`
      select avalon_private.workflow_observe_signal(
        ${runId}::uuid, ${signalId}::uuid, ${controlRevision}
      )
    `;
  }

  async readQueue(queueName: string, limit = 32): Promise<QueueMessage[]> {
    this.#requireRole("queue_runner");
    const rows = await this.#sql<QueueMessageRow[]>`
      select * from avalon_private.queue_read(${queueName}, 60, ${limit})
    `;
    return rows.map((row) => ({
      messageId: safeInteger(row.message_id, "message_id"),
      readCount: row.read_count,
      enqueuedAt: row.enqueued_at,
      visibleAt: row.visible_at,
      message: row.message,
    }));
  }

  async renewQueueMessage(queueName: string, messageId: number): Promise<boolean> {
    this.#requireRole("queue_runner");
    const rows = await this.#sql<{ renewed: boolean }[]>`
      select avalon_private.queue_set_visibility(${queueName}, ${messageId}, 60) as renewed
    `;
    return rows[0]?.renewed ?? false;
  }

  async deleteQueueMessage(queueName: string, messageId: number): Promise<boolean> {
    this.#requireRole("queue_runner");
    const rows = await this.#sql<{ deleted: boolean }[]>`
      select avalon_private.queue_delete(${queueName}, ${messageId}) as deleted
    `;
    return rows[0]?.deleted ?? false;
  }

  async archiveQueueMessage(queueName: string, messageId: number): Promise<boolean> {
    this.#requireRole("queue_runner");
    const rows = await this.#sql<{ archived: boolean }[]>`
      select avalon_private.queue_archive(${queueName}, ${messageId}) as archived
    `;
    return rows[0]?.archived ?? false;
  }

  async deadLetterQueueMessage(input: {
    queueName: string;
    messageId: number;
    semanticKey: string;
    message: JsonValue;
    errorClass: string;
    attempts: number;
  }): Promise<boolean> {
    this.#requireRole("queue_runner");
    const rows = await this.#sql<{ archived: boolean }[]>`
      select avalon_private.queue_dead_letter(
        ${input.queueName}, ${input.messageId}, ${input.semanticKey},
        ${this.#sql.json(input.message)}::jsonb, ${input.errorClass}, ${input.attempts}
      ) as archived
    `;
    return rows[0]?.archived ?? false;
  }

  async claimMigrationJobs(input: {
    campaignId: string;
    leaseOwner: string;
    limit?: number;
  }): Promise<MigrationJobClaim[]> {
    this.#requireRole("queue_runner");
    const rows = await this.#sql<MigrationJobClaimRow[]>`
      select * from avalon_private.claim_migration_jobs(
        ${input.campaignId}::uuid, ${input.leaseOwner}, ${input.limit ?? 16}
      )
    `;
    return rows.map((row) => ({
      jobId: row.job_id,
      leaseToken: row.lease_token,
      campaignPauseEpoch: safeInteger(row.campaign_pause_epoch, "campaign_pause_epoch"),
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      targetKind: row.target_kind,
      ...(row.target_start ? { targetStart: row.target_start } : {}),
      ...(row.target_end ? { targetEnd: row.target_end } : {}),
      ...(row.expected_source_revision === null
        ? {}
        : { expectedSourceRevision: safeInteger(row.expected_source_revision, "expected_source_revision") }),
      attempts: row.attempts,
    }));
  }

  async renewMigrationJob(input: {
    jobId: string;
    leaseOwner: string;
    leaseToken: string;
    campaignPauseEpoch: number;
  }): Promise<boolean> {
    this.#requireRole("queue_runner");
    const rows = await this.#sql<{ renewed: boolean }[]>`
      select avalon_private.renew_migration_job(
        ${input.jobId}::uuid,
        ${input.leaseOwner},
        ${input.leaseToken}::uuid,
        ${input.campaignPauseEpoch}
      ) as renewed
    `;
    return rows[0]?.renewed ?? false;
  }

  async finishMigrationJob(input: {
    jobId: string;
    leaseOwner: string;
    leaseToken: string;
    campaignPauseEpoch: number;
    outcome: "completed" | "failed" | "quarantined";
    semanticTargetKey: string;
    inputCount: number;
    outputCount: number;
    inputHash: Uint8Array;
    outputHash: Uint8Array;
    error?: string;
  }): Promise<Record<string, unknown>> {
    this.#requireRole("queue_runner");
    const rows = await this.#sql<{ value: unknown }[]>`
      select avalon_private.finish_migration_job(
        ${input.jobId}::uuid,
        ${input.leaseOwner},
        ${input.leaseToken}::uuid,
        ${input.campaignPauseEpoch},
        ${input.outcome},
        ${input.semanticTargetKey},
        ${input.inputCount},
        ${input.outputCount},
        ${input.inputHash}::bytea,
        ${input.outputHash}::bytea,
        ${input.error ?? null}
      ) as value
    `;
    return objectValue(rows[0]?.value, "migration_job_settlement");
  }

  async acceptConnectorIngress(input: {
    workspaceId: string;
    installationId: string;
    providerEventId: string;
    bodyHash: Uint8Array;
    byteSize: number;
    boundedBody?: Uint8Array;
    rawContentRefId?: string;
    providerSchemaVersion: string;
    signatureVersion: string;
  }): Promise<Record<string, unknown>> {
    this.#requireRole("regional_router");
    const rows = await this.#sql<{ value: unknown }[]>`
      select avalon_private.accept_connector_ingress(
        ${input.workspaceId}::uuid,
        ${input.installationId}::uuid,
        ${input.providerEventId},
        ${input.bodyHash}::bytea,
        ${input.byteSize},
        ${input.boundedBody ?? null}::bytea,
        ${input.rawContentRefId ?? null}::uuid,
        ${input.providerSchemaVersion},
        ${input.signatureVersion}
      ) as value
    `;
    return objectValue(rows[0]?.value, "connector_ingress_receipt");
  }

  async commitConnectorActivity(input: {
    receiptId: string;
    parserVersion: string;
    events: JsonValue[];
  }): Promise<Record<string, unknown>> {
    this.#requireRole("queue_runner");
    const rows = await this.#sql<{ value: unknown }[]>`
      select avalon_private.commit_connector_activity(
        ${input.receiptId}::uuid,
        ${input.parserVersion},
        ${this.#sql.json(input.events)}::jsonb
      ) as value
    `;
    return objectValue(rows[0]?.value, "connector_activity_receipt");
  }

  #requireRole(expected: DatabaseRole): void {
    if (this.role !== expected) throw new Error(`postgres_role_mismatch:${expected}`);
  }
}
