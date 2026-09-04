import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import {
  UserIdSchema,
  WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
  asWorkspaceId,
  asWorkstreamId,
  WorkstreamControlMetadataSchema,
  WorkstreamControlSocketClientEventSchema,
  WorkstreamControlSocketEventSchema,
  type WorkstreamControlMetadata,
  type UserId,
  type WorkstreamControlSocketEvent,
} from "@rally/contracts";
import type {
  ConversationEffectEnvelope,
  ParentEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import {
  ConversationParentAuthorityRequestSchema,
  ConversationParentAuthorityResultSchema,
  ConversationParentAuthorizeViewerRequestSchema,
  ConversationParentAuthorizeViewerResultSchema,
  ConversationParentReserveChildRequestSchema,
  ConversationParentReserveChildResultSchema,
  type ConversationParentAuthorityRequest,
  type ConversationParentAuthorityResult,
  type ConversationParentAuthorizeViewerRequest,
  type ConversationParentAuthorizeViewerResult,
  type ConversationParentReserveChildRequest,
  type ConversationParentReserveChildResult,
} from "@rally/contracts/conversation-parent";
import { truncateUtf16Safe } from "@rally/contracts/text";
import { z } from "zod";

import type { AuthContext, Env } from "../env";
import { assertDurableObjectJurisdiction } from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { reportScheduledAlarmAttempt } from "./scheduled-alarm-report";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";
import {
  SCHEDULED_ALARM_SCHEMA_STATEMENTS,
  type ScheduledAlarm,
} from "./scheduled-alarms";
import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import {
  CONVERSATION_CHILDREN_SCHEMA_STATEMENTS,
  ConversationParentDurableObject,
  type ConversationParentIdentity,
  type DirectoryCommonEffect,
} from "./conversation-parent-object";
import {
  conversationObjectName,
  workspaceDOName,
  workstreamDOName,
} from "./names";
import { WorkspaceDirectoryApplyResultSchema } from "./workspace-directory-protocol";
import {
  revocationClosesSocket,
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";

const realtimeTextEncoder = new TextEncoder();

function workstreamControlPayload(event: WorkstreamControlSocketEvent): string {
  const payload = JSON.stringify(WorkstreamControlSocketEventSchema.parse(event));
  if (realtimeTextEncoder.encode(payload).byteLength > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
    throw new Error("Work-stream control event exceeds the bounded frame size");
  }
  return payload;
}

const WorkstreamSocketIdentitySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  userId: UserIdSchema,
  sessionId: z.string().min(1).max(200),
  ticketId: z.string().uuid(),
  ticketExpiresAt: z.coerce.number().int().positive(),
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
  created_by_user_id: string | null;
  title_status: "naming" | "automatic" | "settled";
  latest_attention_ordinal: number;
  unread_tracking_start_ordinal: number;
  next_wakeup_due_at: number | null;
  next_wakeup_prompt: string | null;
  next_terminal_action_at: number | null;
  source_created_at: number;
  source_updated_at: number;
}

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
}, {
  version: 5,
  description: "remove retired block dashboard product state and pending deliveries",
  statements: [
    `DROP TABLE IF EXISTS block_dashboard_source_refresh_outbox`,
    `DROP TABLE IF EXISTS block_dashboard_dispatch_outbox`,
    `DROP TABLE IF EXISTS block_dashboard_block_result_receipts`,
    `DROP TABLE IF EXISTS block_dashboard_block_runs`,
    `DROP TABLE IF EXISTS block_dashboard_configuration_versions`,
    `DROP TABLE IF EXISTS block_dashboard_user_preferences`,
  ],
}, {
  version: 6,
  description: "register a child conversation before its first effect arrives",
  statements: [
    // Until now a child existed here only once its first `directory_common`
    // effect landed. Creation now reserves the main conversation before the
    // child object is initialized, and a run or side conversation is reserved
    // the same way, so the parent can list its children without waiting for
    // each to say something. The projection tables keep their shape; this is
    // the registry beside them.
    ...CONVERSATION_CHILDREN_SCHEMA_STATEMENTS,
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

function readSocketAttachment(socket: WebSocket): WorkstreamSocketAttachment | null {
  try {
    const parsed = WorkstreamSocketIdentitySchema.extend({
      connectionId: z.string().uuid(),
      connectedAt: z.string().datetime({ offset: true }),
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

export class WorkstreamDO extends ConversationParentDurableObject {
  private readonly state: DurableObjectState;
  /** This object's own `WORKSTREAM_DOS` name; see {@link selfObjectName}. */
  private objectName: string | null = null;
  private readonly initialized: Promise<void>;

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
          conversationObjectName(env.AVALON_REGION, asWorkspaceId(workspaceId), workstreamId),
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
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        role: "workstream-control",
        databaseBytes: this.state.storage.sql.databaseSize,
      });
    }
    return json({ error: "not_found" }, 404);
  }

  // ---------------------------------------------------------------------------
  // The conversation-parent contract. `receiveChildEffects` and `listChildren`
  // are inherited; the three below need this object's own row.
  // ---------------------------------------------------------------------------

  async authorizeViewer(
    input: ConversationParentAuthorizeViewerRequest,
  ): Promise<ConversationParentAuthorizeViewerResult> {
    await this.initialized;
    const request = ConversationParentAuthorizeViewerRequestSchema.parse(input);
    const row = this.metadataRow();
    if (!row) return ConversationParentAuthorizeViewerResultSchema.parse({ authorized: false, archived: false });
    this.assertParent(request.workspaceId, request.parentId);
    // Archive is reported, not folded into the answer: an archived work stream
    // is still readable by the people who could read it, only not writable.
    const authorized = row.scope === "workspace" || this.isParticipant(request.userId);
    return ConversationParentAuthorizeViewerResultSchema.parse({
      authorized,
      archived: row.archived_at !== null,
    });
  }

  async authority(input: ConversationParentAuthorityRequest): Promise<ConversationParentAuthorityResult> {
    await this.initialized;
    const request = ConversationParentAuthorityRequestSchema.parse(input);
    const row = this.metadataRow();
    if (!row) {
      return ConversationParentAuthorityResultSchema.parse({ exists: false, authorityGeneration: 0, archived: false });
    }
    this.assertParent(request.workspaceId, request.parentId);
    return ConversationParentAuthorityResultSchema.parse({
      exists: true,
      authorityGeneration: row.authority_generation,
      archived: row.archived_at !== null,
    });
  }

  /**
   * Record a child before it is addressed.
   *
   * Reserving the main conversation of a work stream that does not exist yet
   * creates this object's row and puts a provisional directory row in the
   * workspace synchronously, through the one parent-to-workspace RPC that is
   * kept: the person who created the work stream is about to open it, and the
   * Worker's visibility checks read the workspace directory. The provisional
   * row is version 1 of this parent's projection, so the child's first real
   * aggregate lands as version 2 and replaces it.
   */
  async reserveChild(input: ConversationParentReserveChildRequest): Promise<ConversationParentReserveChildResult> {
    await this.initialized;
    const request = ConversationParentReserveChildRequestSchema.parse(input);
    const now = Date.now();
    const reserved = this.state.storage.transactionSync(() => {
      let metadata = this.metadataRow();
      if (!metadata) {
        if (request.substreamId !== "0" || !request.directory) throw new Error("workstream_parent_missing");
        this.insertProvisionalMetadata(request, request.directory, now);
        metadata = this.metadataRow();
        if (!metadata) throw new Error("workstream_metadata_missing");
      } else {
        this.assertParent(request.workspaceId, request.parentId);
      }
      const registered = this.registerChild(request.substreamId, request.kind, request.createdByUserId, now);
      const envelopes: ParentEffectEnvelope[] = [];
      if (registered && request.substreamId === "0" && request.directory) {
        const directory = request.directory;
        const common = this.enqueueProjection("common", {
          kind: "directory_common",
          title: directory.title,
          description: directory.description,
          preview: "",
          scope: directory.scope,
          state: "idle",
          systemKind: directory.systemKind,
          lastActivityAt: directory.createdAt,
          completedAt: null,
          archivedAt: null,
          emailAddress: directory.emailAddress,
          createdByUserId: request.createdByUserId,
          titleStatus: directory.titleStatus,
          createdAt: directory.createdAt,
          updatedAt: directory.createdAt,
        }, now);
        if (common) envelopes.push(common);
        if (request.createdByUserId) {
          const viewer = this.enqueueProjection(`user:${request.createdByUserId}`, {
            kind: "directory_user",
            userId: request.createdByUserId,
            isParticipant: true,
            participantAddedAt: directory.createdAt,
            unreadCount: 0,
            youAreMentioned: false,
            unseen: false,
            listable: true,
          }, now);
          if (viewer) envelopes.push(viewer);
        }
      }
      return { authorityGeneration: metadata.authority_generation, envelopes };
    });
    if (reserved.envelopes.length > 0) await this.deliverProvisionalDirectory(reserved.envelopes);
    await this.armNextAlarm();
    return ConversationParentReserveChildResultSchema.parse({
      reserved: true,
      authorityGeneration: reserved.authorityGeneration,
    });
  }

  private insertProvisionalMetadata(
    request: ConversationParentReserveChildRequest,
    directory: NonNullable<ConversationParentReserveChildRequest["directory"]>,
    now: number,
  ): void {
    const createdAt = epoch(directory.createdAt) ?? now;
    this.state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title, description,
          preview, scope, exact_state, system_kind, last_activity_at, completed_at,
          archived_at, email_address, created_by_user_id, title_status,
          source_created_at, source_updated_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, '', ?, 'idle', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      request.workspaceId,
      request.parentId,
      this.env.AVALON_REGION,
      request.authorityGeneration,
      directory.title,
      directory.description,
      directory.scope,
      directory.systemKind,
      createdAt,
      directory.emailAddress,
      request.createdByUserId,
      directory.titleStatus,
      createdAt,
      createdAt,
      now,
      now,
    );
  }

  /**
   * The one synchronous parent-to-workspace delivery. Rows the workspace
   * accepts leave the outbox here; anything it does not accept stays for the
   * alarm, and the caller hears about it, because a person is waiting on this.
   */
  private async deliverProvisionalDirectory(envelopes: readonly ParentEffectEnvelope[]): Promise<void> {
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
        envelopes: [...envelopes],
      }),
    );
    const accepted = new Set(result.accepted.map((entry) => `${entry.messageId}:${entry.payloadHash}`));
    this.deleteParentEffects(envelopes.filter((envelope) => (
      accepted.has(`${envelope.messageId}:${envelope.payloadHash}`)
    )));
    if (accepted.size !== envelopes.length) throw new Error("workspace_directory_provisional_row_incomplete");
  }

  // ---------------------------------------------------------------------------
  // Hooks the shared parent machinery calls.
  // ---------------------------------------------------------------------------

  protected override parentIdentity(): ConversationParentIdentity | null {
    const row = this.metadataRow();
    return row ? {
      region: row.region,
      workspaceId: asWorkspaceId(row.workspace_id),
      parentKind: "workstream",
      parentId: row.workstream_id,
      authorityGeneration: row.authority_generation,
    } : null;
  }

  protected override admitChildEnvelope(envelope: ConversationEffectEnvelope, now: number): void {
    if (envelope.parentKind !== "workstream") throw new Error("workstream_effect_parent_kind_mismatch");
    const metadata = this.metadataRow();
    // Identity is the workspace and the work stream. The generation is an
    // epoch that this row *follows*, not a gate: it is stamped once when the
    // metadata is first created and never rewritten, while a child stamps
    // every effect with whatever generation is current when it enqueues.
    // Effects are deduped by the receipt table, so accepting an effect from
    // any epoch of the same work stream is safe; the row keeps up with the
    // newest one it has seen.
    if (metadata && (
      metadata.workspace_id !== envelope.workspaceId
      || metadata.workstream_id !== envelope.parentId
    )) throw new Error("workstream_effect_identity_mismatch");
    if (metadata && envelope.generation > metadata.authority_generation) {
      this.state.storage.sql.exec(
        `UPDATE workstream_metadata SET authority_generation = ? WHERE id = 1`,
        envelope.generation,
      );
    }
    if (!metadata) this.ensureMetadata(envelope, now);
  }

  /** A work stream forwards everything its children say. */
  protected override forwardsChildEffect(): boolean {
    return true;
  }

  protected override parentLogFields(): Record<string, unknown> {
    const metadata = this.metadataRow();
    return {
      workspace_id: metadata?.workspace_id ?? null,
      workstream_id: metadata?.workstream_id ?? null,
      parent_kind: "workstream",
    };
  }

  protected override onChildCommonAggregate(
    _substreamId: string,
    aggregate: DirectoryCommonEffect,
    envelope: ConversationEffectEnvelope,
    now: number,
  ): void {
    this.upsertMetadata(envelope, aggregate, now);
  }

  protected override onChildUserAggregate(): void {
    this.state.storage.sql.exec(
      `UPDATE workstream_metadata SET revision = revision + 1, updated_at = ? WHERE id = 1`,
      Date.now(),
    );
  }

  protected override afterChildEffects(): Promise<void> {
    // Everyone reading *this* work stream hears now, over the control socket.
    // Every other surface hears through the outbox, the Queue, and WorkspaceDO.
    return this.broadcastMetadata();
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
   * This object's derived wake reason: outbox rows whose `not_before` has come.
   * The base has already armed the next alarm, so this is free to await the
   * network; a throw costs nothing but the attempt counters the outbox keeps.
   */
  protected override runDueAlarmWork(): Promise<void> {
    return this.drainParentOutbox();
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

  private ensureMetadata(envelope: ConversationEffectEnvelope, now: number): void {
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
      envelope.parentId,
      envelope.region,
      envelope.generation,
      now,
      now,
      now,
    );
  }

  private upsertMetadata(
    envelope: ConversationEffectEnvelope,
    effect: DirectoryCommonEffect,
    now: number,
  ): void {
    this.state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title, description,
          preview, scope, exact_state, system_kind, last_activity_at, completed_at,
          archived_at, created_at, updated_at, revision, email_address,
          created_by_user_id,
          title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
          next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
          source_created_at, source_updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
         preview = excluded.preview, scope = excluded.scope, exact_state = excluded.exact_state,
         system_kind = excluded.system_kind, last_activity_at = excluded.last_activity_at,
         completed_at = excluded.completed_at, archived_at = excluded.archived_at,
         updated_at = excluded.updated_at, revision = workstream_metadata.revision + 1,
         email_address = excluded.email_address,
         created_by_user_id = excluded.created_by_user_id,
         title_status = excluded.title_status,
         latest_attention_ordinal = excluded.latest_attention_ordinal,
         unread_tracking_start_ordinal = excluded.unread_tracking_start_ordinal,
         next_wakeup_due_at = excluded.next_wakeup_due_at,
         next_wakeup_prompt = excluded.next_wakeup_prompt,
         next_terminal_action_at = excluded.next_terminal_action_at,
         source_created_at = excluded.source_created_at,
         source_updated_at = excluded.source_updated_at`,
      envelope.workspaceId,
      envelope.parentId,
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
      effect.createdByUserId ?? null,
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
              archived_at, email_address, created_by_user_id,
              title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
              next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
              source_created_at, source_updated_at
         FROM workstream_metadata WHERE id = 1`,
    ));
  }

  /**
   * Whether one person may currently read this work stream.
   *
   * The public face of the predicate below, for a caller that holds a viewer
   * open against this work stream's content but is not itself this object —
   * today, the artifact supervisor deciding whether a live artifact keeps
   * serving to someone.
   *
   * It exists as an RPC rather than a queue message because **work-stream
   * visibility is not a D1 fact**: it lives in this object's own SQL, and
   * `docs/access-revocation.md` is explicit that routing it through the
   * revocation queue would put a round trip between a scope change and the
   * reader it excludes. So the authority answers directly, exactly as it does
   * for a socket, and the caller caches the answer for a bounded interval
   * rather than asking per request.
   */
  async canReadWorkstream(userId: UserId): Promise<boolean> {
    await this.initialized;
    return this.canRead(userId);
  }

  private canRead(userId: string): boolean {
    const row = this.metadataRow();
    if (!row || row.archived_at !== null) return false;
    if (row.scope === "workspace") return true;
    return this.isParticipant(userId);
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
      createdByUserId: row.created_by_user_id,
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
      },
    });
  }

  /**
   * Drop every socket this object holds for a person whose access ended, and
   * carry the same revocation to its substreams.
   *
   * The only way a socket here is closed for lost access; see
   * `docs/access-revocation.md`. Its registries are the only place its
   * substreams are listed, so it answers with them and stops there —
   * what carries the revocation onward is the consumer's business, not this
   * object's.
   */
  async revokeSocketAccess(
    revocation: SocketAccessRevocation,
  ): Promise<{ substreamIds: string[] }> {
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
    if (!identity) return { substreamIds: [] };
    // Registered children plus any that spoke before registration existed.
    const substreamIds = [...new Set([
      ...this.childRegistry().map((child) => child.substreamId),
      ...this.state.storage.sql.exec<{ substream_id: string }>(
        `SELECT substream_id FROM substream_directory ORDER BY substream_id`,
      ).toArray().map((row) => row.substream_id),
    ])];
    return { substreamIds };
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

  protected override nextDerivedAlarmCandidates(): readonly number[] {
    // SPIKE — throwaway, `spike/demo-workspace-replay` only.
    if (this.spikeRetired()) return [];
    const due = this.nextParentOutboxDueAt();
    return due === null ? [] : [due];
  }
}
