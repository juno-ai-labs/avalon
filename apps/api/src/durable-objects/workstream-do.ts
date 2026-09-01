import { OffsetDateTimeSchema } from "@rally/contracts/schema-runtime";
import { STRICT_UUID_PATTERN } from "@rally/contracts/uuid-validation";
import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import {
  BlockDashboardPreferenceSchema,
  BlockDashboardSchema,
  UserIdSchema,
  WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
  asBlockId,
  asWorkspaceId,
  asWorkstreamId,
  WorkstreamControlMetadataSchema,
  WorkstreamControlSocketClientEventSchema,
  WorkstreamControlSocketEventSchema,
  type WorkstreamControlMetadata,
  type BlockDashboard,
  type BlockDashboardBlockRun,
  type WorkstreamControlSocketEvent,
} from "@rally/contracts";
import { truncateUtf16Safe } from "@rally/contracts/text";
import { z } from "zod/v3";

import type { AuthContext, Env } from "../env";
import { assertDurableObjectJurisdiction } from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import { reportScheduledAlarmAttempt } from "./scheduled-alarm-report";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";
import {
  SCHEDULED_ALARM_SCHEMA_STATEMENTS,
  ScheduledDurableObject,
  type ScheduledAlarm,
} from "./scheduled-alarms";
import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import {
  isRetiredSuggestionFeedbackEffect,
  WorkstreamRegionalEffectAckSchema,
  WorkstreamRegionalEffectEnvelopeSchema,
  WorkstreamRegionalEffectSchema,
  isPersonNotificationEffect,
  workstreamRegionalEffectHash,
  workstreamRegionalEffectWakeMessage,
  type WorkstreamRegionalEffect,
  type WorkstreamRegionalEffectEnvelope,
} from "./workstream-regional-effect";
import {
  BlockDashboardBlockDispatchSchema,
  BlockDashboardControlRequestSchema,
  BlockDashboardSocketRetractionRequestSchema,
  BlockDashboardSourceRefreshRequestSchema,
  BlockDashboardViewerAuthorizationRequestSchema,
  blockDashboardBlockResultHash,
  type BlockDashboardContextFence,
} from "./block-dashboard-protocol";
import {
  blockDashboardAgentName,
  substreamAgentName,
  workspaceDOName,
  workstreamDOName,
} from "./names";
import { WorkspaceDirectoryApplyResultSchema } from "./workspace-directory-protocol";
import { responseToRpcResult, type DurableObjectRpcResult } from "./rpc-result";
import {
  revocationClosesSocket,
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";

const ForwardedEffectsSchema = z.object({
  substreamId: z.string().min(1).max(180),
  envelopes: z.array(WorkstreamRegionalEffectEnvelopeSchema).min(1).max(25),
}).strict();
export type ForwardedEffects = z.infer<typeof ForwardedEffectsSchema>;

const realtimeTextEncoder = new TextEncoder();

function workstreamControlPayload(event: WorkstreamControlSocketEvent): string {
  const payload = JSON.stringify(WorkstreamControlSocketEventSchema.parse(event));
  if (realtimeTextEncoder.encode(payload).byteLength > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
    throw new Error("Work-stream control event exceeds the bounded frame size");
  }
  return payload;
}

interface ProjectionKeyRow extends Record<string, SqlStorageValue> {
  next_version: number;
  last_payload_hash: string;
}

interface StoredEnvelopeRow extends Record<string, SqlStorageValue> {
  payload_json: string;
  payload_hash: string;
  attempts: number;
}

interface StoredProjectionRow extends Record<string, SqlStorageValue> {
  effect_json: string;
}

interface StoredStateRow extends Record<string, SqlStorageValue> {
  event_id: string;
  waterline: number;
}

interface BlockDashboardConfigurationRow extends Record<string, SqlStorageValue> {
  configuration_version_id: string;
  version_number: number;
  blocks_json: string;
  created_at: number;
}

interface BlockDashboardBlockRunRow extends Record<string, SqlStorageValue> {
  block_run_id: string;
  block_id: string;
  configuration_version_id: string;
  trigger_sequence: number;
  status: BlockDashboardBlockRun["status"];
  markdown: string | null;
  error_json: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

const WorkstreamSocketIdentitySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  userId: UserIdSchema,
  sessionId: z.string().min(1).max(200),
  ticketId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
  ticketExpiresAt: z.coerce.number().int().safe().positive(),
});

type WorkstreamSocketIdentity = z.infer<typeof WorkstreamSocketIdentitySchema>;

interface WorkstreamSocketAttachment extends WorkstreamSocketIdentity {
  connectionId: string;
  connectedAt: string;
  subscribed: boolean;
}

interface WorkstreamMetadataRow extends Record<string, SqlStorageValue> {
  revision: number;
  authority_generation: number;
  workspace_id: string;
  workstream_id: string;
  region: "global" | "eu";
  title: string;
  description: string;
  preview: string;
  scope: "personal" | "workspace";
  exact_state: string;
  system_kind: "digest" | null;
  last_activity_at: number;
  completed_at: number | null;
  archived_at: number | null;
  email_address: string | null;
  origin_type: "ad_hoc" | "automation";
  created_by_user_id: string | null;
  automation_subscription_id: string | null;
  automation_run_id: string | null;
  planned_for: number | null;
  title_status: "naming" | "automatic" | "settled";
  latest_attention_ordinal: number;
  unread_tracking_start_ordinal: number;
  next_wakeup_due_at: number | null;
  next_wakeup_prompt: string | null;
  next_terminal_action_at: number | null;
  source_created_at: number;
  source_updated_at: number;
}

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
// Generous fences, not history: the 10 GB object ceiling is the only hard
// bound, so retention errs long. A replay older than the receipt window
// converges on the per-key waterlines; a HyperSight run older than the ledger
// window is superseded display history whose latest row per block is always
// kept regardless of age.
const CHILD_EFFECT_RECEIPT_RETENTION_MS = 180 * 24 * 60 * 60_000;
const BLOCK_RUN_LEDGER_RETENTION_MS = 180 * 24 * 60 * 60_000;

export const WORKSTREAM_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "workstream control-plane metadata, HyperSight coordination, and regional effects",
  statements: [
    `PRAGMA foreign_keys = ON`,
    `CREATE TABLE workstream_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      revision INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      preview TEXT NOT NULL,
      email_address TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      exact_state TEXT NOT NULL CHECK (exact_state IN (
        'scheduled', 'running', 'interrupting', 'preparing_context', 'waiting_capacity',
        'needs_input', 'completed', 'cancelled', 'failed', 'budget_exhausted',
        'idle', 'archived', 'deleting', 'restoring'
      )),
      origin_type TEXT NOT NULL DEFAULT 'ad_hoc'
        CHECK (origin_type IN ('ad_hoc', 'automation')),
      created_by_user_id TEXT,
      automation_subscription_id TEXT,
      automation_run_id TEXT,
      planned_for INTEGER CHECK (planned_for IS NULL OR planned_for >= 0),
      title_status TEXT NOT NULL DEFAULT 'settled'
        CHECK (title_status IN ('naming', 'automatic', 'settled')),
      system_kind TEXT CHECK (system_kind IS NULL OR system_kind = 'digest'),
      last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= 0),
      completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
      latest_attention_ordinal INTEGER NOT NULL DEFAULT 0
        CHECK (latest_attention_ordinal >= 0),
      unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0
        CHECK (unread_tracking_start_ordinal >= 0),
      next_wakeup_due_at INTEGER CHECK (next_wakeup_due_at IS NULL OR next_wakeup_due_at >= 0),
      next_wakeup_prompt TEXT,
      next_terminal_action_at INTEGER
        CHECK (next_terminal_action_at IS NULL OR next_terminal_action_at >= 0),
      source_created_at INTEGER NOT NULL DEFAULT 0 CHECK (source_created_at >= 0),
      source_updated_at INTEGER NOT NULL DEFAULT 0 CHECK (source_updated_at >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE substream_directory (
      substream_id TEXT PRIMARY KEY,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      effect_json TEXT NOT NULL CHECK (
        json_valid(effect_json) AND length(CAST(effect_json AS BLOB)) <= 1900000
      ),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE substream_user_directory (
      substream_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      effect_json TEXT NOT NULL CHECK (
        json_valid(effect_json) AND length(CAST(effect_json AS BLOB)) <= 1900000
      ),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (substream_id, user_id)
    ) STRICT`,
    `CREATE INDEX substream_user_directory_user_idx
      ON substream_user_directory(user_id, substream_id)`,
    `CREATE TABLE child_effect_receipts (
      substream_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      PRIMARY KEY (substream_id, message_id)
    ) STRICT`,
    `CREATE TABLE projection_keys (
      projection_key TEXT PRIMARY KEY,
      next_version INTEGER NOT NULL CHECK (next_version > 0),
      last_payload_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE workstream_state_clock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
      last_event_time INTEGER NOT NULL CHECK (last_event_time >= 0)
    ) STRICT`,
    `INSERT INTO workstream_state_clock(id, next_sequence, last_event_time)
      VALUES (1, 1, 0)`,
    `CREATE TABLE workstream_state_changes (
      sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
      state_key TEXT NOT NULL CHECK (length(state_key) BETWEEN 1 AND 180),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 180),
      payload_hash TEXT NOT NULL,
      state_json TEXT NOT NULL CHECK (json_valid(state_json) AND length(state_json) <= 262144),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      UNIQUE (state_key, waterline)
    ) STRICT`,
    `CREATE INDEX workstream_state_changes_latest_idx
      ON workstream_state_changes(state_key, waterline DESC)`,
    `CREATE TABLE durable_outbox (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'directory_common', 'directory_user', 'suggestion_feedback',
        'activity_event', 'mention_notification'
      )),
      -- The payload budget matches the producing child outbox bound (just
      -- under the platform's 2 MB per-row BYTE ceiling, measured in bytes —
      -- length() on TEXT counts characters) so an envelope the child could
      -- commit is never one this parent must reject: a mid-chain rejection of
      -- an already durable effect is a permanent poison retry.
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
      ),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
    `CREATE TABLE workstream_socket_ticket_receipts (
      ticket_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX workstream_socket_ticket_receipts_expiry_idx
      ON workstream_socket_ticket_receipts(expires_at, ticket_id)`,
    `CREATE TABLE block_dashboard_configuration_versions (
      configuration_version_id TEXT PRIMARY KEY,
      version_number INTEGER NOT NULL UNIQUE CHECK (version_number > 0),
      blocks_json TEXT NOT NULL CHECK (json_valid(blocks_json) AND length(blocks_json) <= 262144),
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE block_dashboard_block_runs (
      block_run_id TEXT PRIMARY KEY,
      configuration_version_id TEXT NOT NULL
        REFERENCES block_dashboard_configuration_versions(configuration_version_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
      harness_run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'stopped')),
      markdown TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      UNIQUE (configuration_version_id, block_id, trigger_sequence)
    ) STRICT`,
    `CREATE INDEX block_dashboard_block_runs_latest_idx
      ON block_dashboard_block_runs(block_id, trigger_sequence DESC, created_at DESC)`,
    `CREATE TABLE block_dashboard_user_preferences (
      user_id TEXT PRIMARY KEY,
      visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE block_dashboard_dispatch_outbox (
      block_run_id TEXT PRIMARY KEY REFERENCES block_dashboard_block_runs(block_run_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      dispatch_json TEXT NOT NULL CHECK (json_valid(dispatch_json) AND length(dispatch_json) <= 262144),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX block_dashboard_dispatch_outbox_due_idx
      ON block_dashboard_dispatch_outbox(not_before, created_at, block_run_id)`,
    `CREATE TABLE block_dashboard_block_result_receipts (
      block_run_id TEXT PRIMARY KEY REFERENCES block_dashboard_block_runs(block_run_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE block_dashboard_source_refresh_outbox (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
  ],
}, {
  version: 2,
  description: "shared multi-alarm index behind this object's single alarm",
  statements: [...SCHEDULED_ALARM_SCHEMA_STATEMENTS],
}, {
  version: 3,
  description: "carry the participant-added notification through this object's outbox",
  statements: [
    // The outbox enumerates the effect kinds it will hold, and a person being
    // added to a work stream is a new one. Enumerating them is worth keeping:
    // this row is what a poison delivery would be stuck on, and a kind nobody
    // downstream handles should fail here rather than in a Queue consumer.
    //
    // SQLite cannot widen a CHECK in place, so the table is rebuilt. Version 1
    // still creates the narrow shape and must — its statements are hashed into
    // every deployed object's `_sql_schema_migrations` receipt, and editing
    // them throws `workstream_do_schema_hash_mismatch:1` in the constructor of
    // every work stream that ran an earlier release.
    `CREATE TABLE durable_outbox_kinds (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'directory_common', 'directory_user', 'suggestion_feedback',
        'activity_event', 'mention_notification', 'participant_notification'
      )),
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
      ),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    // An effect mid-flight keeps its place in the queue rather than being
    // dropped and rediscovered: this runs in the constructor, before the
    // object serves anything, so the copy is of a settled table.
    `INSERT INTO durable_outbox_kinds
       (message_id, partition_key, source_version, source_epoch, effect_kind,
        payload_json, payload_hash, state, attempts, not_before, created_at)
     SELECT message_id, partition_key, source_version, source_epoch, effect_kind,
        payload_json, payload_hash, state, attempts, not_before, created_at
       FROM durable_outbox`,
    `DROP TABLE durable_outbox`,
    `ALTER TABLE durable_outbox_kinds RENAME TO durable_outbox`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
  ],
}, {
  version: 4,
  description: "retire context-suggestion deliveries from the durable outbox",
  statements: [
    `CREATE TABLE durable_outbox_without_suggestions (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'directory_common', 'directory_user', 'activity_event',
        'mention_notification', 'participant_notification'
      )),
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
      ),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `INSERT INTO durable_outbox_without_suggestions
       (message_id, partition_key, source_version, source_epoch, effect_kind,
        payload_json, payload_hash, state, attempts, not_before, created_at)
     SELECT message_id, partition_key, source_version, source_epoch, effect_kind,
            payload_json, payload_hash, state, attempts, not_before, created_at
       FROM durable_outbox WHERE effect_kind != 'suggestion_feedback'`,
    `DROP TABLE durable_outbox`,
    `ALTER TABLE durable_outbox_without_suggestions RENAME TO durable_outbox`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
  ],
}];

function first<T extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<T>): T | null {
  return cursor.toArray()[0] ?? null;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function epoch(timestamp: string | null | undefined): number | null {
  if (timestamp == null) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("invalid_workstream_timestamp");
  return parsed;
}

function parseBlockDashboardBlocks(value: string): Array<{ id: string; prompt: string }> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const id = (entry as { id?: unknown }).id;
      const prompt = (entry as { prompt?: unknown }).prompt;
      return typeof id === "string" && typeof prompt === "string" ? [{ id, prompt }] : [];
    });
  } catch {
    return [];
  }
}

function parseBlockDashboardError(value: string | null): { code: string; message: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { code?: unknown; message?: unknown };
    return typeof parsed.code === "string" && typeof parsed.message === "string"
      ? { code: parsed.code, message: parsed.message }
      : null;
  } catch {
    return null;
  }
}

function blockDashboardRun(row: BlockDashboardBlockRunRow): BlockDashboardBlockRun {
  return {
    id: row.block_run_id,
    blockId: row.block_id,
    configurationVersionId: row.configuration_version_id,
    triggerSequence: row.trigger_sequence,
    status: row.status,
    markdown: row.markdown,
    error: parseBlockDashboardError(row.error_json),
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
}

function readSocketAttachment(socket: WebSocket): WorkstreamSocketAttachment | null {
  try {
    const parsed = WorkstreamSocketIdentitySchema.extend({
      connectionId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
      connectedAt: OffsetDateTimeSchema,
      subscribed: z.boolean(),
    }).safeParse(socket.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function harnessStatus(state: string): WorkstreamControlMetadata["harnessStatus"] {
  if (state === "scheduled") return "scheduled";
  if (["running", "interrupting", "preparing_context", "waiting_capacity"].includes(state)) {
    return "running";
  }
  if (state === "needs_input") return "needs_input";
  if (state === "completed") return "completed";
  if (["failed", "budget_exhausted"].includes(state)) return "failed";
  if (state === "cancelled") return "stopped";
  return "idle";
}

function promptPreview(prompt: string): string {
  return truncateUtf16Safe(prompt.replace(/\s+/gu, " ").trim(), 40);
}

function canonicalState(effects: WorkstreamRegionalEffect[]): string {
  const states = new Set(effects.flatMap((effect) => effect.kind === "directory_common" ? [effect.state] : []));
  for (const state of [
    "running", "interrupting", "preparing_context", "waiting_capacity", "scheduled",
    "needs_input", "failed", "budget_exhausted", "idle", "completed", "cancelled",
  ]) {
    if (states.has(state)) return state;
  }
  return "idle";
}

function newestCommon(effects: WorkstreamRegionalEffect[]): Extract<WorkstreamRegionalEffect, { kind: "directory_common" }> {
  const common = effects.filter((effect): effect is Extract<WorkstreamRegionalEffect, { kind: "directory_common" }> => (
    effect.kind === "directory_common"
  ));
  if (common.length === 0) throw new Error("workstream_common_projection_missing");
  return [...common].sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))[0]!;
}

function latestParticipantAddedAt(
  effects: readonly Extract<WorkstreamRegionalEffect, { kind: "directory_user" }>[],
): string | null {
  let latest: string | null = null;
  for (const effect of effects) {
    if (!effect.isParticipant || effect.participantAddedAt == null) continue;
    if (latest === null || effect.participantAddedAt > latest) latest = effect.participantAddedAt;
  }
  return latest;
}

export { workstreamDOName };

/**
 * WorkstreamDO is the non-agent parent/control object.
 *
 * It owns no transcript and runs no model loop. SubstreamAgent children send
 * versioned state RPCs here. This object aggregates those facts and is the sole
 * object allowed to publish authoritative directory changes to WorkspaceDO or
 * enqueue external activity/notification effects. That prevents one work
 * stream with many substreams from exposing conflicting sidebar versions.
 */
/**
 * The migration runner's component key for this class.
 *
 * One constant because two call sites need the identical value: the runner
 * keys the object's schema ledger by it, and the migration report keys the
 * tracker's component rollup by it. Two literals that drift put an object
 * under a component its own ledger does not use, which shows up as a silent
 * miscount rather than an error.
 */
const MIGRATION_COMPONENT = "workstream_do";

export class WorkstreamDO extends ScheduledDurableObject<Env> {
  private readonly state: DurableObjectState;
  /** This object's own `WORKSTREAM_DOS` name; see {@link selfObjectName}. */
  private objectName: string | null = null;
  private readonly initialized: Promise<void>;
  /**
   * Whether an eager directory delivery is already running. In memory only: a
   * hibernated object wakes with no attempt outstanding, which is the
   * conservative direction — it costs one redundant call the receiving object
   * deduplicates, where the opposite would silently suppress the push.
   */
  private eagerDirectoryDeliveryInFlight = false;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    // Everything downstream is handed this environment or one derived from it,
    // so a helper that addresses "the WorkstreamDO for this work stream" reaches
    // the object it is already running in rather than the namespace. See
    // `lib/durable-object-self.ts`.
    //
    // The parameter is rebound as well as the field, so the rest of this
    // constructor cannot hand the unregistered environment to something
    // long-lived.
    this.env = env = withDurableObjectSelf(env, {
      namespace: env.WORKSTREAM_DOS,
      name: () => this.selfObjectName(),
      id: state.id,
      instance: this,
    });
    // Before the migrations below, not after: the child's cold start is the
    // expensive half and it does not depend on anything this object is about to
    // do. A work stream and its main substream are always opened together — the
    // control socket wakes this object while the feed socket wakes that one —
    // so waking them in sequence pays for two cold starts a person waits
    // through end to end.
    this.wakeMainSubstream(env);
    this.initialized = this.initializeDurableObject(async () => {
      await this.applyMigrations(() => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
      }));
      await this.armNextAlarm();
    });
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  protected override migrationPlan(): DurableObjectMigrationPlan {
    return {
      component: MIGRATION_COMPONENT,
      className: "WorkstreamDO",
      migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
    };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
  }

  /**
   * This object schedules no stored entries of its own yet.
   *
   * Throwing rather than ignoring is deliberate: an entry with no handler is a
   * caller that scheduled work this object cannot do, and the retry gate makes
   * that visible in `_internal_durable_alarms` instead of settling it silently.
   */
  protected override runScheduledAlarm(alarm: ScheduledAlarm): Promise<void> {
    return Promise.reject(new Error(`workstream_object_unknown_alarm_kind:${alarm.kind}`));
  }

  /** No authority gate here: this object forwards effects it already committed. */
  protected override scheduledAlarmDeferral(): Promise<number | null> {
    return Promise.resolve(null);
  }

  protected override onScheduledAlarmFailure(alarm: ScheduledAlarm, error: unknown, attempt: number): void {
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "workstream_object_scheduled_alarm_failed",
      summary: "A work-stream object's alarm entry keeps throwing; `code` is the handler's error, and `alarm_kind` and `alarm_key` name the entry.",
      attempt,
      fields: {
        workstream_id: this.metadataRow()?.workstream_id ?? null,
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
      },
      error,
    });
  }

  protected override onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void {
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "workstream_object_scheduled_alarm_stalled",
      summary: "A work-stream object's alarm entry keeps coming back due at the same instant after running: the source row behind `alarm_kind` and `alarm_key` is not moving. Find why.",
      attempt,
      fields: {
        workstream_id: this.metadataRow()?.workstream_id ?? null,
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
        due_at: new Date(alarm.dueAt).toISOString(),
      },
    });
  }

  /**
   * This object's own name in `WORKSTREAM_DOS`, or `null` before it has one.
   *
   * Memoized: the metadata row's identity is written once and never changes,
   * and this is read on every name resolution the object performs. The read is
   * guarded the same way {@link wakeMainSubstream} guards its own, because a
   * first wake reaches here before the schema exists.
   */
  private selfObjectName(): string | null {
    if (this.objectName !== null) return this.objectName;
    let identity: { workspace_id: string; workstream_id: string } | null;
    try {
      identity = first(this.state.storage.sql.exec<{ workspace_id: string; workstream_id: string }>(
        `SELECT workspace_id, workstream_id FROM workstream_metadata WHERE id = 1`,
      ));
    } catch {
      return null;
    }
    if (!identity) return null;
    this.objectName = workstreamDOName(
      this.env.AVALON_REGION,
      asWorkspaceId(identity.workspace_id),
      asWorkstreamId(identity.workstream_id),
    );
    return this.objectName;
  }

  /**
   * Start substream `0` warming, without waiting for it.
   *
   * Reads identity straight out of storage rather than waiting for the
   * migrations: SQLite persists across hibernation, so on every wake but the
   * first the row is already there. On the first there is no child to wake
   * either, and no table to read — hence the guard rather than a check.
   *
   * Nothing here is awaited or retried. A child that fails to wake is woken by
   * the request that actually needs it, exactly as before; this only ever
   * removes latency, and must never be able to add a failure.
   */
  private wakeMainSubstream(env: Env): void {
    let identity: { workspace_id: string; workstream_id: string } | null;
    try {
      identity = first(this.state.storage.sql.exec<{ workspace_id: string; workstream_id: string }>(
        `SELECT workspace_id, workstream_id FROM workstream_metadata WHERE id = 1`,
      ));
    } catch {
      // First wake: the schema does not exist yet, and neither does the child.
      return;
    }
    if (!identity) return;
    const { workspace_id: workspaceId, workstream_id: workstreamId } = identity;
    this.state.waitUntil((async () => {
      try {
        const stub = await durableObjectStubForWorkspace(
          env,
          env.SUBSTREAM_AGENTS,
          workspaceId,
          substreamAgentName(
            env.AVALON_REGION,
            asWorkspaceId(workspaceId),
            asWorkstreamId(workstreamId),
          ),
        );
        await stub.wake();
      } catch {
        // Warming is best effort by construction.
      }
    })());
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && (path === "/socket" || path === "/")) {
      return this.acceptSocket(request);
    }
    if (request.method === "POST" && path === "/internal/substream-effects") {
      return this.acceptSubstreamEffects(request);
    }
    if (request.method === "POST" && path === "/internal/block-dashboard") {
      return this.acceptBlockDashboardRequest(request);
    }
    if (request.method === "POST" && path === "/internal/regional-effect-delivery") {
      const parsed = WorkstreamRegionalEffectAckSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: "invalid_regional_effect_request" }, 400);
      const envelope = this.regionalEffect(parsed.data.messageId, parsed.data.payloadHash);
      return envelope ? json(envelope) : json({ error: "regional_effect_not_found" }, 404);
    }
    if (request.method === "POST" && path === "/internal/regional-effect-ack") {
      const parsed = WorkstreamRegionalEffectAckSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: "invalid_regional_effect_ack" }, 400);
      return json({ ok: true, removed: this.ack(parsed.data.messageId, parsed.data.payloadHash) });
    }
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        role: "workstream-control",
        databaseBytes: this.state.storage.sql.databaseSize,
      });
    }
    return json({ error: "not_found" }, 404);
  }

  /** Native-RPC entrypoint for ordered child projection delivery. */
  async receiveSubstreamEffects(input: ForwardedEffects): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptSubstreamEffects(new Request(
      "https://workstream.internal/internal/substream-effects",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    )));
  }

  /** Native-RPC entrypoint for all HyperSight control and settlement operations. */
  async controlBlockDashboard(
    input: z.input<typeof BlockDashboardControlRequestSchema>,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptBlockDashboardRequest(new Request(
      "https://workstream.internal/internal/block-dashboard",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    )));
  }

  async loadRegionalEffect(
    input: z.input<typeof WorkstreamRegionalEffectAckSchema>,
  ): Promise<WorkstreamRegionalEffectEnvelope | null> {
    await this.initialized;
    const parsed = WorkstreamRegionalEffectAckSchema.parse(input);
    return this.regionalEffect(parsed.messageId, parsed.payloadHash);
  }

  async acknowledgeRegionalEffect(
    input: z.input<typeof WorkstreamRegionalEffectAckSchema>,
  ): Promise<boolean> {
    await this.initialized;
    const parsed = WorkstreamRegionalEffectAckSchema.parse(input);
    return this.ack(parsed.messageId, parsed.payloadHash);
  }

  /**
   * Hand this commit's directory effects to WorkspaceDO now, rather than
   * leaving them for the alarm.
   *
   * A harness status change reaches the open work stream immediately, over the
   * control socket that `broadcastMetadata` writes to. It reaches every *other*
   * surface — the sidebar row, a second window, another member watching the
   * same workspace — only once the effect has gone outbox, alarm, Queue,
   * consumer batch, RPC. Queues is at-least-once and unordered by design, and
   * the alarm adds its own delay on top, so a transition a person is actively
   * waiting on arrived seconds after the thing that caused it.
   *
   * This delivers but deliberately **does not acknowledge**. The outbox is
   * untouched — no row consumed, no `not_before` moved, no attempt counted — so
   * the alarm, the Queue, and the activation fence keep exactly the lifecycle
   * they had, and this is purely additive. WorkspaceDO applies by `messageId`
   * and `payloadHash`, so the Queue's later copy of the same effect finds the
   * receipt, reports no change, and publishes nothing a second time.
   *
   * Acknowledging here was the first attempt and was wrong. Draining the
   * outbox eagerly meant whoever looked next found it empty: the activation
   * fence reported that it had flushed nothing, and the effects it was supposed
   * to be gating on had already gone. Delivery is a thing this can usefully
   * race the Queue at; ownership of the outbox is not.
   */
  private deliverDirectoryEffectsEagerly(): void {
    if (this.eagerDirectoryDeliveryInFlight) return;
    const effects = this.dueWorkspaceDirectoryEffects(25);
    if (effects.length === 0) return;
    const metadata = this.metadataRow();
    if (!metadata) return;
    this.eagerDirectoryDeliveryInFlight = true;
    this.state.waitUntil((async () => {
      try {
        const workspace = await durableObjectStubForWorkspace(
          this.env,
          this.env.WORKSPACE_DOS,
          metadata.workspace_id,
          workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(metadata.workspace_id)),
        );
        await workspace.applyWorkstreamDirectoryEffects({
          workspaceId: metadata.workspace_id,
          envelopes: effects,
        });
      } catch {
        // The outbox still holds every one of these, so the alarm and the Queue
        // deliver them exactly as they would have. Nothing is lost by losing
        // the race this was trying to win.
      } finally {
        this.eagerDirectoryDeliveryInFlight = false;
      }
    })());
  }

  /** Maintenance activation fence: do not open a route before WorkspaceDO has its directory row. */
  async flushWorkspaceDirectoryEffects(): Promise<number> {
    await this.initialized;
    let delivered = 0;
    for (let batch = 0; batch < 400; batch += 1) {
      // The WorkspaceDO RPC contract caps one atomic application at 25
      // envelopes. Keep maintenance on that same production boundary rather
      // than constructing a one-off oversized activation call.
      const effects = this.dueWorkspaceDirectoryEffects(25);
      if (effects.length === 0) break;
      delivered += await this.deliverWorkspaceDirectoryEffects(effects);
    }
    if (this.dueWorkspaceDirectoryEffects(1).length > 0) {
      throw new Error("workspace_directory_activation_flush_limit");
    }
    await this.armNextAlarm();
    return delivered;
  }

  /** Revalidates a block socket against the parent work-stream authority. */
  async authorizeBlockDashboardBlockViewer(
    input: z.input<typeof BlockDashboardViewerAuthorizationRequestSchema>,
  ): Promise<boolean> {
    await this.initialized;
    const request = BlockDashboardViewerAuthorizationRequestSchema.parse(input);
    const metadata = this.metadataRow();
    if (!metadata
      || metadata.workspace_id !== request.workspaceId
      || metadata.workstream_id !== request.workstreamId
      || !this.canRead(request.userId)) return false;
    const configuration = this.latestBlockDashboardConfiguration();
    return configuration
      ? parseBlockDashboardBlocks(configuration.blocks_json).some((block) => block.id === request.blockId)
      : false;
  }

  override async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.initialized;
    const attachment = readSocketAttachment(socket);
    if (!attachment) {
      socket.close(1011, "Missing work-stream connection identity");
      return;
    }
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      socket.close(1008, "Work-stream control events must be JSON");
      return;
    }
    const parsed = WorkstreamControlSocketClientEventSchema.safeParse(decoded);
    if (!parsed.success) {
      socket.close(1008, "Invalid work-stream control event");
      return;
    }
    const auth = await this.sessionAuth(attachment);
    if (!auth || !this.canRead(attachment.userId)) {
      socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
      return;
    }
    const metadata = this.metadataForUser(attachment.userId);
    if (!metadata) {
      socket.close(1011, "Work-stream metadata is not initialized");
      return;
    }
    socket.serializeAttachment({ ...attachment, subscribed: true });
    socket.send(workstreamControlPayload({
      type: "workstream_metadata",
      occurredAt: new Date().toISOString(),
      metadata,
    }));
  }

  override webSocketClose(): void {
    // Hibernating sockets carry all durable identity in their attachment.
  }

  override webSocketError(): void {
    // The desktop reconnects with a new one-time ticket.
  }

  /**
   * This object's derived wake reasons: outbox rows whose `not_before` has come.
   *
   * The base has already armed the next alarm and drained any stored entry, so
   * everything below is free to await the network — a throw here costs this
   * object nothing but the attempt counters the outbox itself keeps.
   */
  protected override async runDueAlarmWork(): Promise<void> {
    const due = this.dueEffects();
    if (due.length > 0) {
      try {
        // Every committed state change uses the same Queue wake-up path as
        // activity and notification effects. Queues is intentionally treated
        // as at-least-once and unordered; the envelope's state-key waterline is
        // the receiver's freshness authority.
        await this.env.ACTIVITY_QUEUE.sendBatch(due.map((effect) => ({
          body: workstreamRegionalEffectWakeMessage(effect),
        })));
        const now = Date.now();
        this.state.storage.transactionSync(() => {
          for (const effect of due) {
            const row = first(this.state.storage.sql.exec<{ attempts: number }>(
              `SELECT attempts FROM durable_outbox WHERE message_id = ? AND payload_hash = ?`,
              effect.messageId,
              effect.payloadHash,
            ));
            if (!row) continue;
            const attempts = row.attempts + 1;
            const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
            this.state.storage.sql.exec(
              `UPDATE durable_outbox SET state = 'inflight', attempts = ?, not_before = ?
                WHERE message_id = ? AND payload_hash = ?`,
              attempts,
              now + delay,
              effect.messageId,
              effect.payloadHash,
            );
          }
        });
        const metadata = this.metadataRow();
        logInfo(this.env, "workstream_outbox_batch_enqueued", {
          workspace_id: metadata?.workspace_id ?? null,
          workstream_id: metadata?.workstream_id ?? null,
          message_ids: due.map((effect) => effect.messageId),
          effect_kinds: due.map((effect) => effect.effect.kind),
          effect_count: due.length,
          outcome: "queued",
        });
      } catch (error) {
        const retryAt = Date.now() + RETRY_BASE_MS;
        this.state.storage.transactionSync(() => {
          for (const effect of due) {
            this.state.storage.sql.exec(
              `UPDATE durable_outbox SET state = 'pending', attempts = attempts + 1, not_before = ?
                WHERE message_id = ? AND payload_hash = ?`,
              retryAt,
              effect.messageId,
              effect.payloadHash,
            );
          }
        });
        const metadata = this.metadataRow();
        logWarn(this.env, "workstream_outbox_enqueue_failed", {
          workspace_id: metadata?.workspace_id ?? null,
          workstream_id: metadata?.workstream_id ?? null,
          message_ids: due.map((effect) => effect.messageId),
          effect_kinds: due.map((effect) => effect.effect.kind),
          effect_count: due.length,
          retry_at: new Date(retryAt).toISOString(),
          reason: diagnosticErrorCode(error, "queue_send_failed"),
          error_name: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    await this.deliverBlockDashboardSourceRefresh();
    await this.deliverBlockDashboardDispatches();
  }

  private async acceptSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }
    const identity = WorkstreamSocketIdentitySchema.safeParse({
      workspaceId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSPACE_ID) ?? null,
      workstreamId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSTREAM_ID) ?? null,
      userId: readRallyHeader(request.headers, RALLY_HEADERS.USER_ID) ?? null,
      sessionId: readRallyHeader(request.headers, RALLY_HEADERS.SESSION_ID) ?? null,
      ticketId: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_ID) ?? null,
      ticketExpiresAt: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_EXPIRES_AT) ?? null,
    });
    if (!identity.success) return json({ error: "invalid_socket_identity" }, 400);
    const metadata = this.metadataRow();
    if (
      !metadata
      || metadata.workspace_id !== identity.data.workspaceId
      || metadata.workstream_id !== identity.data.workstreamId
    ) return json({ error: "workstream_identity_mismatch" }, 409);
    if (!this.consumeSocketTicket(identity.data)) return json({ error: "socket_ticket_replayed" }, 401);
    const auth = await this.sessionAuth(identity.data);
    if (!auth || !this.canRead(identity.data.userId)) return json({ error: "forbidden" }, 403);

    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) return json({ error: "websocket_unavailable" }, 500);
    const attachment: WorkstreamSocketAttachment = {
      ...identity.data,
      connectionId: uuidV7(),
      connectedAt: new Date().toISOString(),
      subscribed: false,
    };
    this.state.acceptWebSocket(server, [
      attachment.workspaceId,
      attachment.workstreamId,
      attachment.userId,
    ]);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private consumeSocketTicket(identity: WorkstreamSocketIdentity): boolean {
    // Ticket claims carry epoch seconds; object SQL stores unix-ms
    // (data-model invariant 7), so convert once at this boundary.
    const now = Date.now();
    const expiresAtMs = identity.ticketExpiresAt * 1_000;
    if (expiresAtMs <= now) return false;
    return this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `DELETE FROM workstream_socket_ticket_receipts WHERE expires_at < ?`,
        now - 300_000,
      );
      return this.state.storage.sql.exec<{ ticket_id: string }>(
        `INSERT OR IGNORE INTO workstream_socket_ticket_receipts
           (ticket_id, user_id, expires_at, consumed_at)
         VALUES (?, ?, ?, ?) RETURNING ticket_id`,
        identity.ticketId,
        identity.userId,
        expiresAtMs,
        now,
      ).toArray().length === 1;
    });
  }

  private async sessionAuth(
    identity: Pick<WorkstreamSocketIdentity, "sessionId" | "userId" | "workspaceId">,
  ): Promise<AuthContext | null> {
    const role = this.env.APP_ENV === "development"
      && this.env.RALLY_DEV_AUTH === "true"
      && identity.sessionId === "development"
      ? await this.env.DB.prepare(
        `SELECT member.role FROM workspace_members member
          JOIN workspaces workspace ON workspace.id = member.workspace_id
         WHERE member.workspace_id = ? AND member.user_id = ?
           AND member.status = 'active' AND workspace.region = ?
           AND workspace.abandoned_at IS NULL`,
      ).bind(identity.workspaceId, identity.userId, this.env.AVALON_REGION)
        .first<{ role: AuthContext["role"] }>()
      : await this.env.DB.prepare(
        `SELECT member.role FROM sessions session
          JOIN workspace_members member
            ON member.workspace_id = session.workspace_id
           AND member.user_id = session.user_id AND member.status = 'active'
          JOIN workspaces workspace ON workspace.id = session.workspace_id
         WHERE session.id = ? AND session.user_id = ? AND session.workspace_id = ?
           AND session.region = ? AND session.revoked_at IS NULL
           AND session.expires_at > ? AND workspace.region = ?
           AND workspace.abandoned_at IS NULL`,
      ).bind(
        identity.sessionId,
        identity.userId,
        identity.workspaceId,
        this.env.AVALON_REGION,
        new Date().toISOString(),
        this.env.AVALON_REGION,
      ).first<{ role: AuthContext["role"] }>();
    return role ? {
      sessionId: identity.sessionId,
      userId: identity.userId,
      workspaceId: identity.workspaceId,
      region: this.env.AVALON_REGION,
      role: role.role,
    } : null;
  }

  private assertBlockDashboardIdentity(workspaceId: string, workstreamId: string): WorkstreamMetadataRow {
    const metadata = this.metadataRow();
    if (!metadata
      || metadata.workspace_id !== workspaceId
      || metadata.workstream_id !== workstreamId) {
      throw new Error("block_dashboard_workstream_identity_mismatch");
    }
    return metadata;
  }

  private latestBlockDashboardConfiguration(): BlockDashboardConfigurationRow | null {
    return first(this.state.storage.sql.exec<BlockDashboardConfigurationRow>(
      `SELECT configuration_version_id, version_number, blocks_json, created_at
         FROM block_dashboard_configuration_versions
        ORDER BY version_number DESC LIMIT 1`,
    ));
  }

  private loadBlockDashboard(): BlockDashboard {
    const configuration = this.latestBlockDashboardConfiguration();
    if (!configuration) {
      return { versionId: null, versionNumber: 0, blocks: [], updatedAt: null };
    }
    const blocks = parseBlockDashboardBlocks(configuration.blocks_json);
    return BlockDashboardSchema.parse({
      versionId: configuration.configuration_version_id,
      versionNumber: configuration.version_number,
      blocks: blocks.map((block) => {
        const row = first(this.state.storage.sql.exec<BlockDashboardBlockRunRow>(
          `SELECT block_run_id, block_id, configuration_version_id, trigger_sequence,
                  status, markdown, error_json, created_at, started_at, completed_at
             FROM block_dashboard_block_runs
            WHERE configuration_version_id = ? AND block_id = ?
            ORDER BY trigger_sequence DESC, created_at DESC LIMIT 1`,
          configuration.configuration_version_id,
          block.id,
        ));
        return { ...block, latestRun: row ? blockDashboardRun(row) : null };
      }),
      updatedAt: new Date(configuration.created_at).toISOString(),
    });
  }

  private scheduleBlockDashboardRefresh(
    triggerSequence: number,
    contextFence: BlockDashboardContextFence,
  ): BlockDashboardBlockRun[] {
    const metadata = this.metadataRow();
    const configuration = this.latestBlockDashboardConfiguration();
    if (!metadata || !configuration) return [];
    const createdAtMs = Date.now();
    const createdAt = new Date(createdAtMs).toISOString();
    const launched: BlockDashboardBlockRun[] = [];
    for (const block of parseBlockDashboardBlocks(configuration.blocks_json)) {
      if (block.prompt.trim().length === 0) continue;
      const blockRunId = uuidV7();
      const harnessRunId = uuidV7();
      const dispatch = BlockDashboardBlockDispatchSchema.parse({
        region: this.env.AVALON_REGION,
        workspaceId: metadata.workspace_id,
        workstreamId: metadata.workstream_id,
        blockId: block.id,
        blockRunId,
        harnessRunId,
        configurationVersionId: configuration.configuration_version_id,
        configurationVersionNumber: configuration.version_number,
        prompt: block.prompt,
        triggerSequence,
        contextFence,
        createdAt,
      });
      const inserted = this.state.storage.transactionSync(() => {
        const row = this.state.storage.sql.exec<{ block_run_id: string }>(
          `INSERT OR IGNORE INTO block_dashboard_block_runs
             (block_run_id, configuration_version_id, block_id, prompt, trigger_sequence,
              harness_run_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?) RETURNING block_run_id`,
          blockRunId,
          configuration.configuration_version_id,
          block.id,
          block.prompt,
          triggerSequence,
          harnessRunId,
          createdAtMs,
        ).toArray()[0];
        if (!row) return false;
        this.state.storage.sql.exec(
          `INSERT INTO block_dashboard_dispatch_outbox
             (block_run_id, block_id, dispatch_json, attempts, not_before, created_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
          blockRunId,
          block.id,
          JSON.stringify(dispatch),
          createdAtMs,
          createdAtMs,
        );
        return true;
      });
      if (!inserted) continue;
      launched.push({
        id: blockRunId,
        blockId: block.id,
        configurationVersionId: configuration.configuration_version_id,
        triggerSequence,
        status: "queued",
        markdown: null,
        error: null,
        createdAt,
        startedAt: null,
        completedAt: null,
      });
    }
    if (launched.length > 0) {
      // The run ledger is display history: readers use only the latest run
      // per block, so terminal rows past retention age out here — each block's
      // newest run survives regardless of age, and result receipts and stale
      // dispatch rows cascade with their run.
      this.state.storage.sql.exec(
        `DELETE FROM block_dashboard_block_runs
          WHERE block_run_id IN (
            SELECT older.block_run_id FROM block_dashboard_block_runs older
             WHERE older.created_at < ?
               AND older.status IN ('completed', 'failed', 'stopped')
               AND EXISTS (
                 SELECT 1 FROM block_dashboard_block_runs newer
                  WHERE newer.block_id = older.block_id
                    AND newer.trigger_sequence > older.trigger_sequence
               )
             ORDER BY older.created_at LIMIT 100
          )`,
        Date.now() - BLOCK_RUN_LEDGER_RETENTION_MS,
      );
      this.state.waitUntil((async () => {
        await this.deliverBlockDashboardDispatches();
        await this.armNextAlarm();
      })());
    }
    return launched;
  }

  private async acceptBlockDashboardRequest(request: Request): Promise<Response> {
    const parsed = BlockDashboardControlRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid_block_dashboard_request" }, 400);
    try {
      const input = parsed.data;
      const metadata = this.assertBlockDashboardIdentity(input.workspaceId, input.workstreamId);
      if (input.operation === "get") return json({ blockDashboard: this.loadBlockDashboard() });
      if (input.operation === "get_preference") {
        const row = first(this.state.storage.sql.exec<{ visible: number; updated_at: number }>(
          `SELECT visible, updated_at FROM block_dashboard_user_preferences WHERE user_id = ?`,
          input.userId,
        ));
        return json({
          preference: BlockDashboardPreferenceSchema.parse({
            visible: row?.visible === 1,
            updatedAt: row ? new Date(row.updated_at).toISOString() : null,
          }),
        });
      }
      if (input.operation === "update_preference") {
        const updatedAt = Date.parse(input.updatedAt);
        this.state.storage.sql.exec(
          `INSERT INTO block_dashboard_user_preferences(user_id, visible, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET visible = excluded.visible,
             updated_at = excluded.updated_at`,
          input.userId,
          input.visible ? 1 : 0,
          updatedAt,
        );
        const preference = BlockDashboardPreferenceSchema.parse({
          visible: input.visible,
          updatedAt: input.updatedAt,
        });
        await this.broadcastBlockDashboardEvent({
          type: "block_dashboard_preference_updated",
          occurredAt: input.updatedAt,
          preference,
        }, input.userId);
        return json({ preference });
      }
      if (input.operation === "update_configuration") {
        const previousConfiguration = this.latestBlockDashboardConfiguration();
        const previousBlockIds = previousConfiguration
          ? parseBlockDashboardBlocks(previousConfiguration.blocks_json).map((block) => block.id)
          : [];
        const createdAt = Date.parse(input.createdAt);
        const inserted = this.state.storage.transactionSync(() => {
          const current = this.latestBlockDashboardConfiguration()?.version_number ?? 0;
          if (current !== input.input.expectedVersionNumber) return false;
          this.state.storage.sql.exec(
            `INSERT INTO block_dashboard_configuration_versions
               (configuration_version_id, version_number, blocks_json, created_by_user_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            input.configurationVersionId,
            current + 1,
            JSON.stringify(input.input.blocks),
            input.userId,
            createdAt,
          );
          this.queueBlockDashboardSourceRefresh(metadata.revision);
          return true;
        });
        if (!inserted) return json({ error: "block_dashboard_version_conflict" }, 409);
        const blockDashboard = this.loadBlockDashboard();
        await this.broadcastBlockDashboardEvent({
          type: "block_dashboard_configuration_updated",
          occurredAt: input.createdAt,
          blockDashboard,
        });
        const currentBlockIds = new Set(blockDashboard.blocks.map((block) => block.id));
        await this.closeSocketsForRemovedBlocks(
          previousBlockIds.filter((blockId) => !currentBlockIds.has(blockId)),
        );
        this.state.waitUntil((async () => {
          await this.deliverBlockDashboardSourceRefresh();
          await this.armNextAlarm();
        })());
        return json({ blockDashboard, runs: [] });
      }
      if (input.operation === "schedule_refresh") {
        const runs = this.scheduleBlockDashboardRefresh(
          input.triggerSequence,
          input.contextFence,
        );
        return json({ runs });
      }

      if (input.operation === "import_authority_rows") {
        if (metadata.authority_generation !== input.generation) {
          return json({ error: "block_dashboard_import_generation_mismatch" }, 409);
        }
        this.state.storage.transactionSync(() => {
          for (const configuration of input.configurations) {
            this.state.storage.sql.exec(
              `INSERT INTO block_dashboard_configuration_versions
                 (configuration_version_id, version_number, blocks_json,
                  created_by_user_id, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(configuration_version_id) DO UPDATE SET
                 version_number = excluded.version_number,
                 blocks_json = excluded.blocks_json,
                 created_by_user_id = excluded.created_by_user_id,
                 created_at = excluded.created_at`,
              configuration.configurationVersionId,
              configuration.versionNumber,
              configuration.blocksJson,
              configuration.createdByUserId,
              configuration.createdAt,
            );
          }
          for (const run of input.runs) {
            this.state.storage.sql.exec(
              `INSERT INTO block_dashboard_block_runs
                 (block_run_id, configuration_version_id, block_id, prompt,
                  trigger_sequence, harness_run_id, status, markdown, error_json,
                  created_at, started_at, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(block_run_id) DO UPDATE SET
                 configuration_version_id = excluded.configuration_version_id,
                 block_id = excluded.block_id, prompt = excluded.prompt,
                 trigger_sequence = excluded.trigger_sequence,
                 harness_run_id = excluded.harness_run_id, status = excluded.status,
                 markdown = excluded.markdown, error_json = excluded.error_json,
                 created_at = excluded.created_at, started_at = excluded.started_at,
                 completed_at = excluded.completed_at`,
              run.blockRunId,
              run.configurationVersionId,
              run.blockId,
              run.prompt,
              run.triggerSequence,
              run.harnessRunId,
              run.status,
              run.markdown,
              run.errorJson,
              run.createdAt,
              run.startedAt,
              run.completedAt,
            );
          }
          for (const preference of input.preferences) {
            this.state.storage.sql.exec(
              `INSERT INTO block_dashboard_user_preferences(user_id, visible, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET visible = excluded.visible,
                 updated_at = excluded.updated_at`,
              preference.userId,
              preference.visible ? 1 : 0,
              preference.updatedAt,
            );
          }
        });
        return json({ imported: {
          configurations: input.configurations.length,
          runs: input.runs.length,
          preferences: input.preferences.length,
        } });
      }

      if (input.blockId !== input.run.blockId
        || input.payloadHash !== blockDashboardBlockResultHash(input.run)) {
        return json({ error: "block_dashboard_block_result_invalid" }, 409);
      }
      const accepted = this.state.storage.transactionSync(() => {
        const current = first(this.state.storage.sql.exec<{
          block_id: string;
          configuration_version_id: string;
        }>(
          `SELECT block_id, configuration_version_id FROM block_dashboard_block_runs
            WHERE block_run_id = ?`,
          input.run.id,
        ));
        if (!current
          || current.block_id !== input.blockId
          || current.configuration_version_id !== input.run.configurationVersionId) {
          throw new Error("block_dashboard_block_result_identity_mismatch");
        }
        const receipt = first(this.state.storage.sql.exec<{
          source_version: number;
          payload_hash: string;
        }>(
          `SELECT source_version, payload_hash FROM block_dashboard_block_result_receipts
            WHERE block_run_id = ?`,
          input.run.id,
        ));
        if (receipt && receipt.source_version > input.sourceVersion) return false;
        if (receipt?.source_version === input.sourceVersion) {
          if (receipt.payload_hash !== input.payloadHash) {
            throw new Error("block_dashboard_block_result_version_conflict");
          }
          return false;
        }
        this.state.storage.sql.exec(
          `UPDATE block_dashboard_block_runs SET status = ?, markdown = ?, error_json = ?,
             started_at = ?, completed_at = ? WHERE block_run_id = ?`,
          input.run.status,
          input.run.markdown,
          input.run.error ? JSON.stringify(input.run.error) : null,
          input.run.startedAt ? Date.parse(input.run.startedAt) : null,
          input.run.completedAt ? Date.parse(input.run.completedAt) : null,
          input.run.id,
        );
        this.state.storage.sql.exec(
          `INSERT INTO block_dashboard_block_result_receipts
             (block_run_id, block_id, source_version, payload_hash, received_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(block_run_id) DO UPDATE SET source_version = excluded.source_version,
             payload_hash = excluded.payload_hash, received_at = excluded.received_at`,
          input.run.id,
          input.blockId,
          input.sourceVersion,
          input.payloadHash,
          Date.now(),
        );
        return true;
      });
      return json({ accepted });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "block_dashboard_request_failed" }, 409);
    }
  }

  private async broadcastBlockDashboardEvent(
    event: WorkstreamControlSocketEvent,
    audienceUserId?: string,
  ): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) return;
    const activeUsers = new Set(sockets.flatMap((socket) => {
      const attachment = readSocketAttachment(socket);
      return attachment?.subscribed ? [attachment.userId] : [];
    }));
    if (audienceUserId) {
      for (const userId of [...activeUsers]) {
        if (userId !== audienceUserId) activeUsers.delete(userId);
      }
    }
    if (activeUsers.size === 0) return;
    const payload = workstreamControlPayload(event);
    for (const socket of sockets) {
      const attachment = readSocketAttachment(socket);
      if (!attachment?.subscribed || !activeUsers.has(attachment.userId)) continue;
      // Same object-local check as `broadcastMetadata`, and this path has no
      // other guard at all: block dashboard events would otherwise keep
      // flowing to a reader the work stream just excluded.
      if (!this.canRead(attachment.userId)) {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
        continue;
      }
      socket.send(payload);
    }
  }

  /**
   * Close the sockets of blocks that just left the dashboard.
   *
   * A block that stopped existing takes its readers with it, which is a fact
   * about the block rather than about who was reading it. Losing access is a
   * different question with exactly one answer — see `docs/access-revocation.md`
   * — and this must not become a second one.
   */
  private async closeSocketsForRemovedBlocks(blockIds: readonly string[]): Promise<void> {
    const metadata = this.metadataRow();
    if (!metadata || blockIds.length === 0) return;
    await Promise.allSettled(blockIds.map(async (blockId) => {
      const stub = await durableObjectStubForWorkspace(
        this.env,
        this.env.BLOCK_DASHBOARD_AGENTS,
        metadata.workspace_id,
        blockDashboardAgentName(
          this.env.AVALON_REGION,
          asWorkspaceId(metadata.workspace_id),
          asWorkstreamId(metadata.workstream_id),
          asBlockId(blockId),
        ),
      );
      await stub.revalidateViewerAccess(BlockDashboardSocketRetractionRequestSchema.parse({
        workspaceId: metadata.workspace_id,
        workstreamId: metadata.workstream_id,
        blockId,
        region: this.env.AVALON_REGION,
      }));
    }));
  }

  private async deliverBlockDashboardDispatches(limit = 10): Promise<void> {
    const rows = this.state.storage.sql.exec<{
      block_run_id: string;
      block_id: string;
      dispatch_json: string;
      attempts: number;
    }>(
      `SELECT pending.block_run_id, pending.block_id, pending.dispatch_json, pending.attempts
         FROM block_dashboard_dispatch_outbox AS pending
        WHERE pending.not_before <= ?
          AND NOT EXISTS (
            SELECT 1 FROM block_dashboard_dispatch_outbox AS earlier
             WHERE earlier.block_id = pending.block_id
               AND (earlier.created_at < pending.created_at
                 OR (earlier.created_at = pending.created_at
                   AND earlier.block_run_id < pending.block_run_id))
          )
        ORDER BY pending.created_at, pending.block_run_id LIMIT ?`,
      Date.now(),
      limit,
    ).toArray();
    for (const row of rows) {
      let dispatch: z.infer<typeof BlockDashboardBlockDispatchSchema>;
      try {
        dispatch = BlockDashboardBlockDispatchSchema.parse(JSON.parse(row.dispatch_json));
      } catch (error) {
        const completedAt = Date.now();
        this.state.storage.transactionSync(() => {
          this.state.storage.sql.exec(
            `UPDATE block_dashboard_block_runs
                SET status = 'failed', error_json = ?,
                    completed_at = COALESCE(completed_at, ?)
              WHERE block_run_id = ? AND status IN ('queued', 'running')`,
            JSON.stringify({
              code: "block_dashboard_dispatch_invalid",
              message: "The HyperSight block could not start",
            }),
            completedAt,
            row.block_run_id,
          );
          this.state.storage.sql.exec(
            `DELETE FROM block_dashboard_dispatch_outbox WHERE block_run_id = ?`,
            row.block_run_id,
          );
        });
        logWarn(this.env, "block_dashboard_dispatch_invalid", {
          block_id: row.block_id,
          block_run_id: row.block_run_id,
          reason: truncateUtf16Safe(error instanceof Error ? error.message : "unknown", 500),
        });
        await this.broadcastBlockDashboardEvent({
          type: "block_dashboard_configuration_updated",
          occurredAt: new Date(completedAt).toISOString(),
          blockDashboard: this.loadBlockDashboard(),
        });
        continue;
      }
      try {
        const stub = await durableObjectStubForWorkspace(
          this.env,
          this.env.BLOCK_DASHBOARD_AGENTS,
          dispatch.workspaceId,
          blockDashboardAgentName(
            dispatch.region,
            dispatch.workspaceId,
            dispatch.workstreamId,
            dispatch.blockId,
          ),
        );
        await stub.dispatchRun(dispatch);
        this.state.storage.sql.exec(
          `DELETE FROM block_dashboard_dispatch_outbox WHERE block_run_id = ?`,
          row.block_run_id,
        );
      } catch {
        const attempts = row.attempts + 1;
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
        this.state.storage.sql.exec(
          `UPDATE block_dashboard_dispatch_outbox SET attempts = ?, not_before = ?
            WHERE block_run_id = ?`,
          attempts,
          Date.now() + delay,
          row.block_run_id,
        );
      }
    }
  }

  private queueBlockDashboardSourceRefresh(triggerSequence: number): void {
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO block_dashboard_source_refresh_outbox
         (id, trigger_sequence, attempts, not_before, created_at, updated_at)
       VALUES (1, ?, 0, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         trigger_sequence = MAX(block_dashboard_source_refresh_outbox.trigger_sequence,
                                excluded.trigger_sequence),
         attempts = 0,
         not_before = MIN(block_dashboard_source_refresh_outbox.not_before, excluded.not_before),
         updated_at = excluded.updated_at`,
      triggerSequence,
      now,
      now,
      now,
    );
  }

  private async deliverBlockDashboardSourceRefresh(): Promise<void> {
    const row = first(this.state.storage.sql.exec<{
      trigger_sequence: number;
      attempts: number;
    }>(
      `SELECT trigger_sequence, attempts FROM block_dashboard_source_refresh_outbox
        WHERE id = 1 AND not_before <= ?`,
      Date.now(),
    ));
    if (!row) return;
    const metadata = this.metadataRow();
    if (!metadata) return;
    try {
      const request = BlockDashboardSourceRefreshRequestSchema.parse({
        workspaceId: metadata.workspace_id,
        workstreamId: metadata.workstream_id,
        triggerSequence: row.trigger_sequence,
      });
      const stub = await durableObjectStubForWorkspace(
        this.env,
        this.env.SUBSTREAM_AGENTS,
        metadata.workspace_id,
        substreamAgentName(
          this.env.AVALON_REGION,
          asWorkspaceId(metadata.workspace_id),
          asWorkstreamId(metadata.workstream_id),
        ),
      );
      const response = await stub.requestBlockDashboardRefresh(request);
      if (!response.accepted) {
        throw new Error(response.error ?? "block_dashboard_source_refresh_rejected");
      }
      this.state.storage.sql.exec(
        `DELETE FROM block_dashboard_source_refresh_outbox
          WHERE id = 1 AND trigger_sequence = ?`,
        row.trigger_sequence,
      );
    } catch {
      const attempts = row.attempts + 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
      this.state.storage.sql.exec(
        `UPDATE block_dashboard_source_refresh_outbox
            SET attempts = ?, not_before = ?, updated_at = ?
          WHERE id = 1 AND trigger_sequence = ?`,
        attempts,
        Date.now() + delay,
        Date.now(),
        row.trigger_sequence,
      );
    }
  }

  private async acceptSubstreamEffects(request: Request): Promise<Response> {
    const parsed = ForwardedEffectsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid_substream_effects" }, 400);
    try {
      let accepted = 0;
      for (const envelope of parsed.data.envelopes) {
        if (envelope.region !== this.env.AVALON_REGION) throw new Error("workstream_effect_region_mismatch");
        // An old child may have committed this just before the deployment.
        // Returning it as accepted lets that child delete the row; persisting
        // it in the new parent would revive the retired feedback protocol.
        if (!isRetiredSuggestionFeedbackEffect(envelope.effect)) {
          this.applyChildEnvelope(parsed.data.substreamId, envelope);
        }
        accepted += 1;
      }
      await this.armNextAlarm();
      await this.broadcastMetadata();
      // `broadcastMetadata` has just told everyone reading *this* work stream.
      // The same transition is what a sidebar row, a second window, and every
      // other member of the workspace are waiting on, and their only path to it
      // is the workspace socket — so start it here instead of at the alarm.
      this.deliverDirectoryEffectsEagerly();
      // A visibility change used to sweep block sockets from here. It no
      // longer does: closing somebody's socket because their access ended is
      // the access-revocation queue's job and nothing else's, so that this
      // object cannot hold a second, quieter answer to the same question. See
      // docs/access-revocation.md. Block lifecycle is a different question and
      // still sweeps, at the configuration-change site that knows the answer.
      return json({ ok: true, accepted });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "substream_effect_failed" }, 409);
    }
  }

  private applyChildEnvelope(substreamId: string, envelope: WorkstreamRegionalEffectEnvelope): void {
    this.state.storage.transactionSync(() => {
      const metadata = first(this.state.storage.sql.exec<{
        workspace_id: string;
        workstream_id: string;
        authority_generation: number;
      }>(`SELECT workspace_id, workstream_id, authority_generation FROM workstream_metadata WHERE id = 1`));
      // Identity is the workspace and the work stream. The generation is an
      // epoch that this row *follows*, not a gate: it is stamped once when the
      // metadata is first created and never rewritten, while a child stamps
      // every effect with whatever generation is current when it enqueues.
      // Gating on equality therefore only ever held for a cutover that ran
      // exactly once — any restart moved the child forward, left this row
      // behind, and made every effect permanently unacceptable in one
      // direction or the other. Effects are deduped by `child_effect_receipts`
      // below, and no new work is admitted while a campaign runs, so accepting
      // an effect from any epoch of the same work stream is safe; the row
      // simply keeps up with the newest one it has seen.
      if (metadata && (
        metadata.workspace_id !== envelope.workspaceId
        || metadata.workstream_id !== envelope.workstreamId
      )) throw new Error("workstream_effect_identity_mismatch");
      if (metadata && envelope.generation > metadata.authority_generation) {
        this.state.storage.sql.exec(
          `UPDATE workstream_metadata SET authority_generation = ? WHERE id = 1`,
          envelope.generation,
        );
      }

      const receipt = first(this.state.storage.sql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM child_effect_receipts WHERE substream_id = ? AND message_id = ?`,
        substreamId,
        envelope.messageId,
      ));
      if (receipt) {
        if (receipt.payload_hash !== envelope.payloadHash) throw new Error("substream_effect_idempotency_conflict");
        return;
      }

      const now = Date.now();
      if (envelope.effect.kind === "directory_common") {
        this.upsertChildProjection("common", substreamId, null, envelope, now);
        const effect = this.aggregateCommon();
        this.upsertMetadata(envelope, effect, now);
        this.enqueueProjection(envelope, "common", effect, now);
      } else if (envelope.effect.kind === "directory_user") {
        this.upsertChildProjection("user", substreamId, envelope.effect.userId, envelope, now);
        const effect = this.aggregateUser(envelope.effect.userId);
        this.ensureMetadata(envelope, now);
        this.state.storage.sql.exec(
          `UPDATE workstream_metadata SET revision = revision + 1, updated_at = ? WHERE id = 1`,
          now,
        );
        this.enqueueProjection(envelope, `user:${envelope.effect.userId}`, effect, now);
      } else {
        this.ensureMetadata(envelope, now);
        this.enqueueImmutable(substreamId, envelope, now);
      }
      this.state.storage.sql.exec(
        `INSERT INTO child_effect_receipts(substream_id, message_id, payload_hash, received_at)
         VALUES (?, ?, ?, ?)`,
        substreamId,
        envelope.messageId,
        envelope.payloadHash,
        now,
      );
      // The receipt is a replay fence, not history. Past retention a
      // redelivery converges on the per-key waterlines instead, so old
      // receipts age out here the way every sibling receipt table's do.
      this.state.storage.sql.exec(
        `DELETE FROM child_effect_receipts
          WHERE (substream_id, message_id) IN (
            SELECT substream_id, message_id FROM child_effect_receipts
             WHERE received_at < ?
             ORDER BY received_at LIMIT 100
          )`,
        now - CHILD_EFFECT_RECEIPT_RETENTION_MS,
      );
    });
  }

  private upsertChildProjection(
    kind: "common" | "user",
    substreamId: string,
    userId: string | null,
    envelope: WorkstreamRegionalEffectEnvelope,
    now: number,
  ): void {
    const table = kind === "common" ? "substream_directory" : "substream_user_directory";
    const where = kind === "common" ? "substream_id = ?" : "substream_id = ? AND user_id = ?";
    const params = kind === "common" ? [substreamId] : [substreamId, userId!];
    const existing = first(this.state.storage.sql.exec<{ source_version: number; payload_hash: string }>(
      `SELECT source_version, payload_hash FROM ${table} WHERE ${where}`,
      ...params,
    ));
    if (existing && existing.source_version > envelope.sourceVersion) return;
    if (existing?.source_version === envelope.sourceVersion) {
      if (existing.payload_hash === envelope.payloadHash) return;
      // Same version, different content. The child numbers these itself and
      // restarts its counter when a maintenance import rebuilds it, while this
      // projection survives — so a re-derived effect legitimately arrives under
      // a version this object has already seen carrying different bytes. The
      // child is the authority for its own projection, so the newer payload
      // wins rather than failing the campaign. It is still worth saying out
      // loud: outside a campaign the two should never disagree.
      logWarn(this.env, "substream_projection_version_reused", {
        substream_id: substreamId,
        source_version: envelope.sourceVersion,
        workstream_id: envelope.workstreamId,
      });
    }
    if (kind === "common") {
      this.state.storage.sql.exec(
        `INSERT INTO substream_directory(substream_id, source_version, payload_hash, effect_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(substream_id) DO UPDATE SET source_version = excluded.source_version,
           payload_hash = excluded.payload_hash, effect_json = excluded.effect_json,
           updated_at = excluded.updated_at`,
        substreamId,
        envelope.sourceVersion,
        envelope.payloadHash,
        JSON.stringify(envelope.effect),
        now,
      );
    } else {
      this.state.storage.sql.exec(
        `INSERT INTO substream_user_directory
           (substream_id, user_id, source_version, payload_hash, effect_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(substream_id, user_id) DO UPDATE SET source_version = excluded.source_version,
           payload_hash = excluded.payload_hash, effect_json = excluded.effect_json,
           updated_at = excluded.updated_at`,
        substreamId,
        userId,
        envelope.sourceVersion,
        envelope.payloadHash,
        JSON.stringify(envelope.effect),
        now,
      );
    }
  }

  private aggregateCommon(): Extract<WorkstreamRegionalEffect, { kind: "directory_common" }> {
    const effects = this.state.storage.sql.exec<StoredProjectionRow>(
      `SELECT effect_json FROM substream_directory ORDER BY substream_id`,
    ).toArray().map((row) => WorkstreamRegionalEffectSchema.parse(JSON.parse(row.effect_json)));
    const base = newestCommon(effects);
    const common = effects.filter((effect): effect is Extract<WorkstreamRegionalEffect, { kind: "directory_common" }> => (
      effect.kind === "directory_common"
    ));
    const lastActivityAt = common.reduce(
      (latest, effect) => effect.lastActivityAt > latest ? effect.lastActivityAt : latest,
      base.lastActivityAt,
    );
    return {
      ...base,
      state: canonicalState(effects),
      lastActivityAt,
      completedAt: common.every((effect) => effect.completedAt !== null) ? lastActivityAt : null,
    };
  }

  private aggregateUser(userId: string): Extract<WorkstreamRegionalEffect, { kind: "directory_user" }> {
    const effects = this.state.storage.sql.exec<StoredProjectionRow>(
      `SELECT effect_json FROM substream_user_directory WHERE user_id = ? ORDER BY substream_id`,
      userId,
    ).toArray().map((row) => WorkstreamRegionalEffectSchema.parse(JSON.parse(row.effect_json)))
      .filter((effect): effect is Extract<WorkstreamRegionalEffect, { kind: "directory_user" }> => (
        effect.kind === "directory_user"
      ));
    if (effects.length === 0) throw new Error("workstream_user_projection_missing");
    return {
      kind: "directory_user",
      userId,
      isParticipant: effects.some((effect) => effect.isParticipant),
      participantAddedAt: latestParticipantAddedAt(effects),
      unreadCount: effects.reduce((count, effect) => count + effect.unreadCount, 0),
      youAreMentioned: effects.some((effect) => effect.youAreMentioned),
      // An OR across substreams, which is only the top level's answer because
      // there is exactly one substream today. A second one would mean a room
      // nobody opened lighting the parent's dot, so whoever adds substreams
      // decides then whether unseen is per-substream or the root's alone.
      unseen: effects.some((effect) => effect.unseen === true),
      listable: effects.some((effect) => effect.listable),
      seenAttentionOrdinal: Math.max(...effects.map((effect) => effect.seenAttentionOrdinal ?? 0)),
      manualUnreadFromOrdinal: effects.reduce<number | null>((earliest, effect) => {
        const value = effect.manualUnreadFromOrdinal ?? null;
        return value === null ? earliest : earliest === null ? value : Math.min(earliest, value);
      }, null),
      manualUnreadGeneration: Math.max(...effects.map((effect) => effect.manualUnreadGeneration ?? 0)),
      latestMentionAttentionOrdinal: Math.max(...effects.map((effect) => effect.latestMentionAttentionOrdinal ?? 0)),
    };
  }

  private ensureMetadata(envelope: WorkstreamRegionalEffectEnvelope, now: number): void {
    const existing = first(this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM workstream_metadata WHERE id = 1`,
    ));
    if (existing) return;
    this.state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title, description,
          preview, scope, exact_state, system_kind, last_activity_at, completed_at,
          archived_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, '', '', '', 'workspace', 'idle', NULL, ?, NULL, NULL, ?, ?)`,
      envelope.workspaceId,
      envelope.workstreamId,
      envelope.region,
      envelope.generation,
      now,
      now,
      now,
    );
  }

  private upsertMetadata(
    envelope: WorkstreamRegionalEffectEnvelope,
    effect: Extract<WorkstreamRegionalEffect, { kind: "directory_common" }>,
    now: number,
  ): void {
    this.state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title, description,
          preview, scope, exact_state, system_kind, last_activity_at, completed_at,
          archived_at, created_at, updated_at, revision, email_address, origin_type,
          created_by_user_id, automation_subscription_id, automation_run_id, planned_for,
          title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
          next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
          source_created_at, source_updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
         preview = excluded.preview, scope = excluded.scope, exact_state = excluded.exact_state,
         system_kind = excluded.system_kind, last_activity_at = excluded.last_activity_at,
         completed_at = excluded.completed_at, archived_at = excluded.archived_at,
         updated_at = excluded.updated_at, revision = workstream_metadata.revision + 1,
         email_address = excluded.email_address, origin_type = excluded.origin_type,
         created_by_user_id = excluded.created_by_user_id,
         automation_subscription_id = excluded.automation_subscription_id,
         automation_run_id = excluded.automation_run_id, planned_for = excluded.planned_for,
         title_status = excluded.title_status,
         latest_attention_ordinal = excluded.latest_attention_ordinal,
         unread_tracking_start_ordinal = excluded.unread_tracking_start_ordinal,
         next_wakeup_due_at = excluded.next_wakeup_due_at,
         next_wakeup_prompt = excluded.next_wakeup_prompt,
         next_terminal_action_at = excluded.next_terminal_action_at,
         source_created_at = excluded.source_created_at,
         source_updated_at = excluded.source_updated_at`,
      envelope.workspaceId,
      envelope.workstreamId,
      envelope.region,
      envelope.generation,
      effect.title,
      effect.description,
      effect.preview,
      effect.scope,
      effect.state,
      effect.systemKind,
      epoch(effect.lastActivityAt),
      epoch(effect.completedAt),
      epoch(effect.archivedAt),
      now,
      now,
      effect.emailAddress ?? null,
      effect.originType ?? "ad_hoc",
      effect.createdByUserId ?? null,
      effect.automationSubscriptionId ?? null,
      effect.automationRunId ?? null,
      epoch(effect.plannedFor),
      effect.titleStatus ?? "settled",
      effect.latestAttentionOrdinal ?? 0,
      effect.unreadTrackingStartOrdinal ?? 0,
      epoch(effect.nextWakeupDueAt),
      effect.nextWakeupPrompt ?? null,
      epoch(effect.nextTerminalActionAt),
      epoch(effect.createdAt ?? effect.lastActivityAt),
      epoch(effect.updatedAt ?? effect.lastActivityAt),
    );
  }

  private metadataRow(): WorkstreamMetadataRow | null {
    return first(this.state.storage.sql.exec<WorkstreamMetadataRow>(
      `SELECT revision, authority_generation, workspace_id, workstream_id, region, title, description, preview,
              scope, exact_state, system_kind, last_activity_at, completed_at,
              archived_at, email_address, origin_type, created_by_user_id,
              automation_subscription_id, automation_run_id, planned_for,
              title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
              next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
              source_created_at, source_updated_at
         FROM workstream_metadata WHERE id = 1`,
    ));
  }

  private userProjection(userId: string): Extract<WorkstreamRegionalEffect, { kind: "directory_user" }> | null {
    const effects = this.state.storage.sql.exec<StoredProjectionRow>(
      `SELECT effect_json FROM substream_user_directory WHERE user_id = ? ORDER BY substream_id`,
      userId,
    ).toArray().map((row) => WorkstreamRegionalEffectSchema.parse(JSON.parse(row.effect_json)))
      .filter((effect): effect is Extract<WorkstreamRegionalEffect, { kind: "directory_user" }> => (
        effect.kind === "directory_user"
      ));
    if (effects.length === 0) return null;
    return {
      kind: "directory_user",
      userId,
      isParticipant: effects.some((effect) => effect.isParticipant),
      participantAddedAt: latestParticipantAddedAt(effects),
      unreadCount: effects.reduce((count, effect) => count + effect.unreadCount, 0),
      youAreMentioned: effects.some((effect) => effect.youAreMentioned),
      // An OR across substreams, which is only the top level's answer because
      // there is exactly one substream today. A second one would mean a room
      // nobody opened lighting the parent's dot, so whoever adds substreams
      // decides then whether unseen is per-substream or the root's alone.
      unseen: effects.some((effect) => effect.unseen === true),
      listable: effects.some((effect) => effect.listable),
      seenAttentionOrdinal: Math.max(...effects.map((effect) => effect.seenAttentionOrdinal ?? 0)),
      manualUnreadFromOrdinal: effects.reduce<number | null>((earliest, effect) => {
        const value = effect.manualUnreadFromOrdinal ?? null;
        return value === null ? earliest : earliest === null ? value : Math.min(earliest, value);
      }, null),
      manualUnreadGeneration: Math.max(...effects.map((effect) => effect.manualUnreadGeneration ?? 0)),
      latestMentionAttentionOrdinal: Math.max(...effects.map((effect) => effect.latestMentionAttentionOrdinal ?? 0)),
    };
  }

  private canRead(userId: string): boolean {
    const row = this.metadataRow();
    if (!row || row.archived_at !== null) return false;
    if (row.scope === "workspace") return true;
    return this.userProjection(userId)?.isParticipant === true;
  }

  private latestStateRow(stateKey: string): StoredStateRow | null {
    return first(this.state.storage.sql.exec<StoredStateRow>(
      `SELECT event_id, waterline FROM workstream_state_changes
        WHERE state_key = ? ORDER BY waterline DESC LIMIT 1`,
      stateKey,
    ));
  }

  private stateVersionForUser(row: WorkstreamMetadataRow, userId: string) {
    const common = this.latestStateRow("common");
    if (!common) throw new Error("workstream_common_state_missing");
    const viewer = this.latestStateRow(`user:${userId}`);
    return {
      commonEventId: common.event_id,
      viewerEventId: viewer?.event_id ?? null,
      authorityGeneration: row.authority_generation,
      commonWaterline: common.waterline,
      viewerWaterline: viewer?.waterline ?? 0,
    };
  }

  private metadataForUser(userId: string): WorkstreamControlMetadata | null {
    const row = this.metadataRow();
    if (!row) return null;
    const viewer = this.userProjection(userId);
    const readThrough = viewer?.seenAttentionOrdinal ?? row.unread_tracking_start_ordinal;
    const nextPendingWakeup = row.next_wakeup_due_at && row.next_wakeup_prompt
      ? { dueAt: iso(row.next_wakeup_due_at), promptPreview: promptPreview(row.next_wakeup_prompt) }
      : null;
    return WorkstreamControlMetadataSchema.parse({
      stateVersion: this.stateVersionForUser(row, userId),
      revision: row.revision,
      id: row.workstream_id,
      workspaceId: row.workspace_id,
      title: row.title,
      description: row.description,
      preview: row.preview,
      emailAddress: row.email_address,
      originType: row.origin_type,
      createdByUserId: row.created_by_user_id,
      automationSubscriptionId: row.automation_subscription_id,
      automationRunId: row.automation_run_id,
      plannedFor: iso(row.planned_for),
      titleStatus: row.title_status,
      exactState: row.exact_state,
      harnessStatus: harnessStatus(row.exact_state),
      latestAttentionSequenceNumber: row.latest_attention_ordinal,
      unreadTrackingStartSequenceNumber: row.unread_tracking_start_ordinal,
      lastActivityAt: iso(row.last_activity_at),
      completedAt: iso(row.completed_at),
      archivedAt: iso(row.archived_at),
      createdAt: iso(row.source_created_at),
      updatedAt: iso(row.source_updated_at),
      scope: row.scope,
      systemKind: row.system_kind,
      nextPendingWakeup,
      nextTerminalActionAt: iso(row.next_terminal_action_at),
      viewer: {
        isParticipant: viewer?.isParticipant ?? false,
        listable: row.archived_at === null
          && (row.scope === "workspace" || viewer?.isParticipant === true)
          && (viewer?.listable ?? true),
        unreadCount: viewer?.unreadCount ?? 0,
        youAreMentioned: viewer?.youAreMentioned ?? false,
        unseen: viewer?.unseen ?? false,
        readThroughSequenceNumber: readThrough,
        manualUnreadFromSequenceNumber: viewer?.manualUnreadFromOrdinal ?? null,
        manualUnreadGeneration: viewer?.manualUnreadGeneration ?? 0,
        latestMentionSequenceNumber: viewer?.latestMentionAttentionOrdinal ?? 0,
        blockDashboardPreference: this.blockDashboardPreferenceFor(userId),
      },
    });
  }

  /** Absent means hidden, which is what a work stream opens as. */
  private blockDashboardPreferenceFor(userId: string): { visible: boolean; updatedAt: string | null } {
    const row = first(this.state.storage.sql.exec<{ visible: number; updated_at: number }>(
      `SELECT visible, updated_at FROM block_dashboard_user_preferences WHERE user_id = ?`,
      userId,
    ));
    return {
      visible: row?.visible === 1,
      updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    };
  }

  /**
   * Drop every socket this object holds for a person whose access ended, and
   * carry the same revocation to its substreams and blocks.
   *
   * The only way a socket here is closed for lost access; see
   * `docs/access-revocation.md`. Its registries are the only place its
   * substreams and blocks are listed, so it answers with them and stops there —
   * what carries the revocation onward is the consumer's business, not this
   * object's.
   */
  async revokeSocketAccess(
    revocation: SocketAccessRevocation,
  ): Promise<{ substreamIds: string[]; blockIds: string[] }> {
    await this.initialized;
    const request = SocketAccessRevocationSchema.parse(revocation);
    const identity = this.metadataRow();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readSocketAttachment(socket);
      if (!attachment || !revocationClosesSocket(request, attachment)) continue;
      try {
        socket.serializeAttachment({ ...attachment, subscribed: false });
      } catch {
        // An unreadable attachment already fails the broadcast filter.
      }
      try {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
      } catch {
        // Already closing; the runtime owns the rest of the teardown.
      }
    }
    if (!identity) return { substreamIds: [], blockIds: [] };
    const configuration = this.latestBlockDashboardConfiguration();
    // The main substream keeps the historical name and is never listed in the
    // directory, so it is named here rather than discovered.
    const substreamIds = [
      "0",
      ...this.state.storage.sql.exec<{ substream_id: string }>(
        `SELECT substream_id FROM substream_directory ORDER BY substream_id`,
      ).toArray().map((row) => row.substream_id).filter((substreamId) => substreamId !== "0"),
    ];
    return {
      substreamIds,
      blockIds: (configuration ? parseBlockDashboardBlocks(configuration.blocks_json) : [])
        .map((block) => block.id),
    };
  }

  private async broadcastMetadata(): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) return;
    const activeUsers = new Set<string>();
    for (const socket of sockets) {
      const attachment = readSocketAttachment(socket);
      if (!attachment?.subscribed) continue;
      activeUsers.add(attachment.userId);
    }
    if (activeUsers.size === 0) return;
    const occurredAt = new Date().toISOString();
    for (const socket of sockets) {
      const attachment = readSocketAttachment(socket);
      if (!attachment?.subscribed) continue;
      // Object-local, and deliberately still here. What was removed from this
      // path is the D1 `workspace_members` read — a question this object cannot
      // answer, which the revocation queue now answers properly. Whether this
      // work stream is still readable by this person is a different question,
      // answered entirely from this object's own SQL, and it is the only place
      // that can answer it. `metadataForUser` does not consult it, so without
      // this a reader excluded by a scope change keeps receiving title,
      // description, preview and state until they close the window.
      if (!this.canRead(attachment.userId)) {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
        continue;
      }
      const metadata = this.metadataForUser(attachment.userId);
      if (!metadata) continue;
      socket.send(workstreamControlPayload({
        type: "workstream_metadata",
        occurredAt,
        metadata,
      }));
    }
  }

  private enqueueProjection(
    source: WorkstreamRegionalEffectEnvelope,
    projectionKey: string,
    effect: WorkstreamRegionalEffect,
    now: number,
  ): void {
    const payloadHash = workstreamRegionalEffectHash(effect);
    const previous = first(this.state.storage.sql.exec<ProjectionKeyRow>(
      `SELECT next_version, last_payload_hash FROM projection_keys WHERE projection_key = ?`,
      projectionKey,
    ));
    if (previous?.last_payload_hash === payloadHash) return;
    const sourceVersion = previous?.next_version ?? 1;
    const messageId = this.recordStateChange(projectionKey, sourceVersion, effect, payloadHash, now);
    this.state.storage.sql.exec(
      `INSERT INTO projection_keys(projection_key, next_version, last_payload_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET next_version = excluded.next_version,
         last_payload_hash = excluded.last_payload_hash, updated_at = excluded.updated_at`,
      projectionKey,
      sourceVersion + 1,
      payloadHash,
      now,
    );
    this.insertOutbox({
      ...source,
      messageId,
      partitionKey: projectionKey,
      sourceVersion,
      requiredProjectionVersion: null,
      payloadHash,
      effect,
    }, now);
  }

  /**
   * Append one immutable UI state row before its Queue wake-up can exist.
   *
   * The timestamp-prefixed ID is useful for cross-socket traces and sorts by
   * observed wall time. The state-key waterline remains the correctness clock:
   * clocks in independent Durable Objects cannot provide a global total order.
   */
  private recordStateChange(
    stateKey: string,
    waterline: number,
    effect: WorkstreamRegionalEffect,
    payloadHash: string,
    now: number,
  ): string {
    const metadata = this.metadataRow();
    if (!metadata) throw new Error("workstream_metadata_missing");
    const clock = first(this.state.storage.sql.exec<{
      next_sequence: number;
      last_event_time: number;
    }>(`SELECT next_sequence, last_event_time FROM workstream_state_clock WHERE id = 1`));
    if (!clock) throw new Error("workstream_state_clock_missing");
    const occurredAt = Math.max(now, clock.last_event_time);
    const sequence = clock.next_sequence;
    const eventId = uuidV7(occurredAt);
    this.state.storage.sql.exec(
      `UPDATE workstream_state_clock
          SET next_sequence = ?, last_event_time = ? WHERE id = 1`,
      sequence + 1,
      occurredAt,
    );
    this.state.storage.sql.exec(
      `INSERT INTO workstream_state_changes
         (sequence, state_key, waterline, event_id, payload_hash, state_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sequence,
      stateKey,
      waterline,
      eventId,
      payloadHash,
      JSON.stringify(effect),
      occurredAt,
    );
    // Reconnects need the current row, not every transition ever observed.
    // Keep a bounded diagnostic/replay tail per independent state key.
    this.state.storage.sql.exec(
      `DELETE FROM workstream_state_changes
        WHERE state_key = ? AND waterline <= ?`,
      stateKey,
      waterline - 1_024,
    );
    return eventId;
  }

  private enqueueImmutable(substreamId: string, source: WorkstreamRegionalEffectEnvelope, now: number): void {
    let requiredProjectionVersion: number | null = null;
    if (isPersonNotificationEffect(source.effect)) {
      const key = `user:${source.effect.recipientUserId}`;
      const projection = first(this.state.storage.sql.exec<ProjectionKeyRow>(
        `SELECT next_version, last_payload_hash FROM projection_keys WHERE projection_key = ?`,
        key,
      ));
      requiredProjectionVersion = (projection?.next_version ?? 1) - 1;
      if (requiredProjectionVersion <= 0) throw new Error("workstream_notification_projection_dependency_uncommitted");
    }
    const messageId = `substream:${substreamId}:${source.messageId}`;
    const payloadHash = workstreamRegionalEffectHash(source.effect, requiredProjectionVersion);
    this.insertOutbox({
      ...source,
      messageId,
      requiredProjectionVersion,
      payloadHash,
    }, now);
  }

  private insertOutbox(envelope: WorkstreamRegionalEffectEnvelope, now: number): void {
    const inserted = this.state.storage.sql.exec<{ message_id: string }>(
      `INSERT OR IGNORE INTO durable_outbox
         (message_id, partition_key, source_version, source_epoch, effect_kind,
          payload_json, payload_hash, state, attempts, not_before, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       RETURNING message_id`,
      envelope.messageId,
      envelope.partitionKey,
      envelope.sourceVersion,
      envelope.generation,
      envelope.effect.kind,
      JSON.stringify(WorkstreamRegionalEffectEnvelopeSchema.parse(envelope)),
      envelope.payloadHash,
      now,
      now,
    );
    if (inserted.toArray().length === 0) {
      const existing = first(this.state.storage.sql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM durable_outbox WHERE message_id = ?`,
        envelope.messageId,
      ));
      if (existing?.payload_hash !== envelope.payloadHash) throw new Error("workstream_parent_outbox_conflict");
    }
  }

  private dueEffects(limit = 25): WorkstreamRegionalEffectEnvelope[] {
    return this.state.storage.sql.exec<StoredEnvelopeRow>(
      `SELECT payload_json, payload_hash, attempts FROM durable_outbox
        WHERE state IN ('pending', 'inflight') AND not_before <= ?
        ORDER BY CASE effect_kind
                   WHEN 'directory_common' THEN 0
                   WHEN 'directory_user' THEN 1
                   ELSE 2
                 END,
                 created_at, message_id LIMIT ?`,
      Date.now(),
      limit,
    ).toArray().map((row) => WorkstreamRegionalEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
  }

  private dueWorkspaceDirectoryEffects(limit: number): WorkstreamRegionalEffectEnvelope[] {
    return this.state.storage.sql.exec<StoredEnvelopeRow>(
      `SELECT payload_json, payload_hash, attempts FROM durable_outbox
        WHERE state IN ('pending', 'inflight')
          AND effect_kind IN ('directory_common', 'directory_user')
        ORDER BY CASE effect_kind
                   WHEN 'directory_common' THEN 0
                   WHEN 'directory_user' THEN 1
                   ELSE 2
                 END,
                 created_at, message_id LIMIT ?`,
      limit,
    ).toArray().map((row) => WorkstreamRegionalEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
  }

  private regionalEffect(messageId: string, payloadHash: string): WorkstreamRegionalEffectEnvelope | null {
    const row = first(this.state.storage.sql.exec<StoredEnvelopeRow>(
      `SELECT payload_json, payload_hash, attempts FROM durable_outbox
        WHERE message_id = ? AND payload_hash = ? AND state IN ('pending', 'inflight')`,
      messageId,
      payloadHash,
    ));
    return row ? WorkstreamRegionalEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  private ack(messageId: string, payloadHash: string): boolean {
    return this.state.storage.sql.exec<{ message_id: string }>(
      `DELETE FROM durable_outbox WHERE message_id = ? AND payload_hash = ?
       RETURNING message_id`,
      messageId,
      payloadHash,
    ).toArray().length === 1;
  }

  private async deliverWorkspaceDirectoryEffects(
    effects: WorkstreamRegionalEffectEnvelope[],
  ): Promise<number> {
    if (effects.length === 0) return 0;
    const ordered = [...effects].sort((left, right) => {
      const priority = (effect: WorkstreamRegionalEffectEnvelope) => (
        effect.effect.kind === "directory_common" ? 0 : effect.effect.kind === "directory_user" ? 1 : 2
      );
      return priority(left) - priority(right);
    });
    try {
      const metadata = this.metadataRow();
      if (!metadata) throw new Error("workstream_metadata_missing");
      const workspace = await durableObjectStubForWorkspace(
        this.env,
        this.env.WORKSPACE_DOS,
        metadata.workspace_id,
        workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(metadata.workspace_id)),
      );
      const result = WorkspaceDirectoryApplyResultSchema.parse(
        await workspace.applyWorkstreamDirectoryEffects({
          workspaceId: metadata.workspace_id,
          envelopes: ordered,
        }),
      );
      const accepted = new Map(result.accepted.map((entry) => [entry.messageId, entry.payloadHash]));
      let delivered = 0;
      this.state.storage.transactionSync(() => {
        for (const effect of effects) {
          if (accepted.get(effect.messageId) !== effect.payloadHash) continue;
          if (this.ack(effect.messageId, effect.payloadHash)) delivered += 1;
        }
      });
      if (delivered !== effects.length) throw new Error("workspace_directory_effect_ack_incomplete");
      return delivered;
    } catch (error) {
      const retryAt = Date.now() + RETRY_BASE_MS;
      this.state.storage.transactionSync(() => {
        for (const effect of effects) {
          this.state.storage.sql.exec(
            `UPDATE durable_outbox SET state = 'pending', attempts = attempts + 1, not_before = ?
              WHERE message_id = ? AND payload_hash = ?`,
            retryAt,
            effect.messageId,
            effect.payloadHash,
          );
        }
      });
      throw error;
    }
  }

  protected override nextDerivedAlarmCandidates(): readonly number[] {
    const regional = first(this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM durable_outbox WHERE state IN ('pending', 'inflight')`,
    ))?.due_at ?? null;
    const blockDashboard = first(this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM block_dashboard_dispatch_outbox`,
    ))?.due_at ?? null;
    const sourceRefresh = first(this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM block_dashboard_source_refresh_outbox`,
    ))?.due_at ?? null;
    return [regional, blockDashboard, sourceRefresh]
      .filter((candidate): candidate is number => candidate !== null);
  }
}
