import {
  HyperSightPreferenceSchema,
  HyperSightSchema,
  IdSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkstreamControlMetadataSchema,
  WorkstreamControlSocketClientEventSchema,
  WorkstreamControlSocketEventSchema,
  type WorkstreamControlMetadata,
  type HyperSight,
  type HyperSightBlockRun,
  type WorkstreamControlSocketEvent,
} from "@avalon/contracts";
import { truncateUtf16Safe } from "@avalon/contracts/text";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";

import type { AuthContext, Env } from "../env";
import { assertDurableObjectJurisdiction } from "../lib/durable-object-namespace";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";
import {
  WorkstreamRegionalEffectAckSchema,
  WorkstreamRegionalEffectEnvelopeSchema,
  WorkstreamRegionalEffectSchema,
  workstreamRegionalEffectHash,
  workstreamRegionalEffectWakeMessage,
  type WorkstreamRegionalEffect,
  type WorkstreamRegionalEffectEnvelope,
} from "./workstream-regional-effect";
import {
  HyperSightBlockDispatchSchema,
  HyperSightControlRequestSchema,
  HyperSightSourceRefreshRequestSchema,
  hyperSightBlockResultHash,
  type HyperSightContextFence,
} from "./hypersight-protocol";
import { hyperSightBlockAgentName, substreamAgentName } from "./names";

const ForwardedEffectsSchema = z.object({
  substreamId: z.string().min(1).max(180),
  envelopes: z.array(WorkstreamRegionalEffectEnvelopeSchema).min(1).max(25),
}).strict();

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

interface HyperSightConfigurationRow extends Record<string, SqlStorageValue> {
  configuration_version_id: string;
  version_number: number;
  blocks_json: string;
  created_at: number;
}

interface HyperSightBlockRunRow extends Record<string, SqlStorageValue> {
  block_run_id: string;
  block_id: string;
  configuration_version_id: string;
  trigger_sequence: number;
  status: HyperSightBlockRun["status"];
  markdown: string | null;
  error_json: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

const WorkstreamSocketIdentitySchema = z.object({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  userId: IdSchema,
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

export const WORKSTREAM_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "workstream parent metadata, child projections, and regional outbox",
  statements: [
    `PRAGMA foreign_keys = ON`,
    `CREATE TABLE workstream_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      preview TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      exact_state TEXT NOT NULL CHECK (exact_state IN (
        'scheduled', 'running', 'interrupting', 'preparing_context', 'waiting_capacity',
        'needs_input', 'completed', 'cancelled', 'failed', 'budget_exhausted',
        'idle', 'archived', 'deleting', 'restoring'
      )),
      system_kind TEXT CHECK (system_kind IS NULL OR system_kind = 'digest'),
      last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= 0),
      completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE substream_directory (
      substream_id TEXT PRIMARY KEY,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      effect_json TEXT NOT NULL CHECK (json_valid(effect_json) AND length(effect_json) <= 262144),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE substream_user_directory (
      substream_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      effect_json TEXT NOT NULL CHECK (json_valid(effect_json) AND length(effect_json) <= 262144),
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
    `CREATE TABLE durable_outbox (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 262144),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
  ],
}, {
  version: 2,
  description: "workstream metadata sync socket and complete common projection",
  statements: [
    `ALTER TABLE workstream_metadata ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE workstream_metadata ADD COLUMN email_address TEXT`,
    `ALTER TABLE workstream_metadata ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'ad_hoc'
      CHECK (origin_type IN ('ad_hoc', 'automation'))`,
    `ALTER TABLE workstream_metadata ADD COLUMN created_by_user_id TEXT`,
    `ALTER TABLE workstream_metadata ADD COLUMN automation_subscription_id TEXT`,
    `ALTER TABLE workstream_metadata ADD COLUMN automation_run_id TEXT`,
    `ALTER TABLE workstream_metadata ADD COLUMN planned_for INTEGER
      CHECK (planned_for IS NULL OR planned_for >= 0)`,
    `ALTER TABLE workstream_metadata ADD COLUMN title_status TEXT NOT NULL DEFAULT 'settled'
      CHECK (title_status IN ('naming', 'automatic', 'settled'))`,
    `ALTER TABLE workstream_metadata ADD COLUMN latest_attention_ordinal INTEGER NOT NULL DEFAULT 0
      CHECK (latest_attention_ordinal >= 0)`,
    `ALTER TABLE workstream_metadata ADD COLUMN unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0
      CHECK (unread_tracking_start_ordinal >= 0)`,
    `ALTER TABLE workstream_metadata ADD COLUMN next_wakeup_due_at INTEGER
      CHECK (next_wakeup_due_at IS NULL OR next_wakeup_due_at >= 0)`,
    `ALTER TABLE workstream_metadata ADD COLUMN next_wakeup_prompt TEXT`,
    `ALTER TABLE workstream_metadata ADD COLUMN next_terminal_action_at INTEGER
      CHECK (next_terminal_action_at IS NULL OR next_terminal_action_at >= 0)`,
    `ALTER TABLE workstream_metadata ADD COLUMN source_created_at INTEGER NOT NULL DEFAULT 0
      CHECK (source_created_at >= 0)`,
    `ALTER TABLE workstream_metadata ADD COLUMN source_updated_at INTEGER NOT NULL DEFAULT 0
      CHECK (source_updated_at >= 0)`,
    `CREATE TABLE workstream_socket_ticket_receipts (
      ticket_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX workstream_socket_ticket_receipts_expiry_idx
      ON workstream_socket_ticket_receipts(expires_at, ticket_id)`,
  ],
}, {
  version: 3,
  description: "HyperSight configuration authority, block projections, and durable dispatch",
  statements: [
    `CREATE TABLE hypersight_configuration_versions (
      configuration_version_id TEXT PRIMARY KEY,
      version_number INTEGER NOT NULL UNIQUE CHECK (version_number > 0),
      blocks_json TEXT NOT NULL CHECK (json_valid(blocks_json) AND length(blocks_json) <= 262144),
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE hypersight_block_runs (
      block_run_id TEXT PRIMARY KEY,
      configuration_version_id TEXT NOT NULL
        REFERENCES hypersight_configuration_versions(configuration_version_id) ON DELETE CASCADE,
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
    `CREATE INDEX hypersight_block_runs_latest_idx
      ON hypersight_block_runs(block_id, trigger_sequence DESC, created_at DESC)`,
    `CREATE TABLE hypersight_user_preferences (
      user_id TEXT PRIMARY KEY,
      visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE hypersight_dispatch_outbox (
      block_run_id TEXT PRIMARY KEY REFERENCES hypersight_block_runs(block_run_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      dispatch_json TEXT NOT NULL CHECK (json_valid(dispatch_json) AND length(dispatch_json) <= 262144),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX hypersight_dispatch_outbox_due_idx
      ON hypersight_dispatch_outbox(not_before, created_at, block_run_id)`,
    `CREATE TABLE hypersight_block_result_receipts (
      block_run_id TEXT PRIMARY KEY REFERENCES hypersight_block_runs(block_run_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL
    ) STRICT`,
  ],
}, {
  version: 4,
  description: "durable HyperSight source-refresh delivery to the main SubstreamAgent",
  statements: [
    `CREATE TABLE hypersight_source_refresh_outbox (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX hypersight_source_refresh_outbox_due_idx
      ON hypersight_source_refresh_outbox(not_before, id)`,
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

function parseHyperSightBlocks(value: string): Array<{ id: string; prompt: string }> {
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

function parseHyperSightError(value: string | null): { code: string; message: string } | null {
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

function hyperSightRun(row: HyperSightBlockRunRow): HyperSightBlockRun {
  return {
    id: row.block_run_id,
    blockId: row.block_id,
    configurationVersionId: row.configuration_version_id,
    triggerSequence: row.trigger_sequence,
    status: row.status,
    markdown: row.markdown,
    error: parseHyperSightError(row.error_json),
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
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

export { workstreamDOName } from "./names";

/**
 * WorkstreamDO is the non-agent parent/control object.
 *
 * It owns no transcript and runs no model loop. SubstreamAgent children send
 * versioned projection RPCs here. This object aggregates those projections and
 * is the sole object allowed to wake the regional D1/sidebar/notification
 * bridge, which prevents one work stream with many substreams from exposing
 * conflicting sidebar versions.
 */
export class WorkstreamDO extends DurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly initialized: Promise<void>;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    this.initialized = state.blockConcurrencyWhile(async () => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
        component: "workstream_do",
        workerVersionId: env.APP_VERSION ?? "unknown",
      });
      const next = this.nextAlarmAt();
      if (next !== null) await state.storage.setAlarm(next);
    });
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
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
    if (request.method === "POST" && path === "/internal/hypersight") {
      return this.acceptHyperSightRequest(request);
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
    socket.send(JSON.stringify(WorkstreamControlSocketEventSchema.parse({
      type: "workstream_metadata",
      occurredAt: new Date().toISOString(),
      metadata,
    })));
  }

  override webSocketClose(): void {
    // Hibernating sockets carry all durable identity in their attachment.
  }

  override webSocketError(): void {
    // The desktop reconnects with a new one-time ticket.
  }

  override async alarm(): Promise<void> {
    await this.initialized;
    const due = this.dueEffects();
    if (due.length > 0) {
      try {
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
      } catch {
        this.state.storage.sql.exec(
          `UPDATE durable_outbox SET state = 'pending', attempts = attempts + 1, not_before = ?
            WHERE state IN ('pending', 'inflight') AND not_before <= ?`,
          Date.now() + RETRY_BASE_MS,
          Date.now(),
        );
      }
    }
    await this.deliverHyperSightSourceRefresh();
    await this.deliverHyperSightDispatches();
    await this.armAlarm();
  }

  private async acceptSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }
    const identity = WorkstreamSocketIdentitySchema.safeParse({
      workspaceId: request.headers.get("x-avalon-workspace-id"),
      workstreamId: request.headers.get("x-avalon-workstream-id"),
      userId: request.headers.get("x-avalon-user-id"),
      sessionId: request.headers.get("x-avalon-session-id"),
      ticketId: request.headers.get("x-avalon-socket-ticket-id"),
      ticketExpiresAt: request.headers.get("x-avalon-socket-ticket-expires-at"),
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
      connectionId: crypto.randomUUID(),
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
    const now = Math.floor(Date.now() / 1_000);
    if (identity.ticketExpiresAt <= now) return false;
    return this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `DELETE FROM workstream_socket_ticket_receipts WHERE expires_at < ?`,
        now - 300,
      );
      return this.state.storage.sql.exec<{ ticket_id: string }>(
        `INSERT OR IGNORE INTO workstream_socket_ticket_receipts
           (ticket_id, user_id, expires_at, consumed_at)
         VALUES (?, ?, ?, ?) RETURNING ticket_id`,
        identity.ticketId,
        identity.userId,
        identity.ticketExpiresAt,
        now,
      ).toArray().length === 1;
    });
  }

  private async sessionAuth(
    identity: Pick<WorkstreamSocketIdentity, "sessionId" | "userId" | "workspaceId">,
  ): Promise<AuthContext | null> {
    const role = this.env.APP_ENV === "development"
      && this.env.AVALON_DEV_AUTH === "true"
      && identity.sessionId === "development"
      ? await this.env.DB.prepare(
        `SELECT member.role FROM workspace_members member
          JOIN workspaces workspace ON workspace.id = member.workspace_id
         WHERE member.workspace_id = ? AND member.user_id = ?
           AND member.status = 'active' AND workspace.region = ?`,
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
           AND session.expires_at > ? AND workspace.region = ?`,
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

  private assertHyperSightIdentity(workspaceId: string, workstreamId: string): WorkstreamMetadataRow {
    const metadata = this.metadataRow();
    if (!metadata
      || metadata.workspace_id !== workspaceId
      || metadata.workstream_id !== workstreamId) {
      throw new Error("hypersight_workstream_identity_mismatch");
    }
    return metadata;
  }

  private latestHyperSightConfiguration(): HyperSightConfigurationRow | null {
    return first(this.state.storage.sql.exec<HyperSightConfigurationRow>(
      `SELECT configuration_version_id, version_number, blocks_json, created_at
         FROM hypersight_configuration_versions
        ORDER BY version_number DESC LIMIT 1`,
    ));
  }

  private loadHyperSight(): HyperSight {
    const configuration = this.latestHyperSightConfiguration();
    if (!configuration) {
      return { versionId: null, versionNumber: 0, blocks: [], updatedAt: null };
    }
    const blocks = parseHyperSightBlocks(configuration.blocks_json);
    return HyperSightSchema.parse({
      versionId: configuration.configuration_version_id,
      versionNumber: configuration.version_number,
      blocks: blocks.map((block) => {
        const row = first(this.state.storage.sql.exec<HyperSightBlockRunRow>(
          `SELECT block_run_id, block_id, configuration_version_id, trigger_sequence,
                  status, markdown, error_json, created_at, started_at, completed_at
             FROM hypersight_block_runs
            WHERE configuration_version_id = ? AND block_id = ?
            ORDER BY trigger_sequence DESC, created_at DESC LIMIT 1`,
          configuration.configuration_version_id,
          block.id,
        ));
        return { ...block, latestRun: row ? hyperSightRun(row) : null };
      }),
      updatedAt: new Date(configuration.created_at).toISOString(),
    });
  }

  private scheduleHyperSightRefresh(
    triggerSequence: number,
    contextFence: HyperSightContextFence,
  ): HyperSightBlockRun[] {
    const metadata = this.metadataRow();
    const configuration = this.latestHyperSightConfiguration();
    if (!metadata || !configuration) return [];
    const createdAtMs = Date.now();
    const createdAt = new Date(createdAtMs).toISOString();
    const launched: HyperSightBlockRun[] = [];
    for (const block of parseHyperSightBlocks(configuration.blocks_json)) {
      if (block.prompt.trim().length === 0) continue;
      const blockRunId = crypto.randomUUID();
      const harnessRunId = crypto.randomUUID();
      const dispatch = HyperSightBlockDispatchSchema.parse({
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
          `INSERT OR IGNORE INTO hypersight_block_runs
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
          `INSERT INTO hypersight_dispatch_outbox
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
      this.state.waitUntil((async () => {
        await this.deliverHyperSightDispatches();
        await this.armAlarm();
      })());
    }
    return launched;
  }

  private async acceptHyperSightRequest(request: Request): Promise<Response> {
    const parsed = HyperSightControlRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid_hypersight_request" }, 400);
    try {
      const input = parsed.data;
      const metadata = this.assertHyperSightIdentity(input.workspaceId, input.workstreamId);
      if (input.operation === "get") return json({ hypersight: this.loadHyperSight() });
      if (input.operation === "get_preference") {
        const row = first(this.state.storage.sql.exec<{ visible: number; updated_at: number }>(
          `SELECT visible, updated_at FROM hypersight_user_preferences WHERE user_id = ?`,
          input.userId,
        ));
        return json({
          preference: HyperSightPreferenceSchema.parse({
            visible: row?.visible === 1,
            updatedAt: row ? new Date(row.updated_at).toISOString() : null,
          }),
        });
      }
      if (input.operation === "update_preference") {
        const updatedAt = Date.parse(input.updatedAt);
        this.state.storage.sql.exec(
          `INSERT INTO hypersight_user_preferences(user_id, visible, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET visible = excluded.visible,
             updated_at = excluded.updated_at`,
          input.userId,
          input.visible ? 1 : 0,
          updatedAt,
        );
        const preference = HyperSightPreferenceSchema.parse({
          visible: input.visible,
          updatedAt: input.updatedAt,
        });
        await this.broadcastHyperSightEvent({
          type: "hypersight_preference_updated",
          occurredAt: input.updatedAt,
          preference,
        }, input.userId);
        return json({ preference });
      }
      if (input.operation === "update_configuration") {
        const createdAt = Date.parse(input.createdAt);
        const inserted = this.state.storage.transactionSync(() => {
          const current = this.latestHyperSightConfiguration()?.version_number ?? 0;
          if (current !== input.input.expectedVersionNumber) return false;
          this.state.storage.sql.exec(
            `INSERT INTO hypersight_configuration_versions
               (configuration_version_id, version_number, blocks_json, created_by_user_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            input.configurationVersionId,
            current + 1,
            JSON.stringify(input.input.blocks),
            input.userId,
            createdAt,
          );
          this.queueHyperSightSourceRefresh(metadata.revision);
          return true;
        });
        if (!inserted) return json({ error: "hypersight_version_conflict" }, 409);
        const hypersight = this.loadHyperSight();
        await this.broadcastHyperSightEvent({
          type: "hypersight_configuration_updated",
          occurredAt: input.createdAt,
          hypersight,
        });
        this.state.waitUntil((async () => {
          await this.deliverHyperSightSourceRefresh();
          await this.armAlarm();
        })());
        return json({ hypersight, runs: [] });
      }
      if (input.operation === "schedule_refresh") {
        const runs = this.scheduleHyperSightRefresh(
          input.triggerSequence,
          input.contextFence,
        );
        for (const run of runs) {
          await this.broadcastHyperSightEvent({
            type: "hypersight_block_run_updated",
            occurredAt: new Date().toISOString(),
            run,
          });
        }
        return json({ runs });
      }

      if (input.operation === "import_authority_rows") {
        if (metadata.authority_generation !== input.generation) {
          return json({ error: "hypersight_import_generation_mismatch" }, 409);
        }
        this.state.storage.transactionSync(() => {
          for (const configuration of input.configurations) {
            this.state.storage.sql.exec(
              `INSERT INTO hypersight_configuration_versions
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
              `INSERT INTO hypersight_block_runs
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
              `INSERT INTO hypersight_user_preferences(user_id, visible, updated_at)
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
        || input.payloadHash !== hyperSightBlockResultHash(input.run)) {
        return json({ error: "hypersight_block_result_invalid" }, 409);
      }
      const accepted = this.state.storage.transactionSync(() => {
        const current = first(this.state.storage.sql.exec<{
          block_id: string;
          configuration_version_id: string;
        }>(
          `SELECT block_id, configuration_version_id FROM hypersight_block_runs
            WHERE block_run_id = ?`,
          input.run.id,
        ));
        if (!current
          || current.block_id !== input.blockId
          || current.configuration_version_id !== input.run.configurationVersionId) {
          throw new Error("hypersight_block_result_identity_mismatch");
        }
        const receipt = first(this.state.storage.sql.exec<{
          source_version: number;
          payload_hash: string;
        }>(
          `SELECT source_version, payload_hash FROM hypersight_block_result_receipts
            WHERE block_run_id = ?`,
          input.run.id,
        ));
        if (receipt && receipt.source_version > input.sourceVersion) return false;
        if (receipt?.source_version === input.sourceVersion) {
          if (receipt.payload_hash !== input.payloadHash) {
            throw new Error("hypersight_block_result_version_conflict");
          }
          return false;
        }
        this.state.storage.sql.exec(
          `UPDATE hypersight_block_runs SET status = ?, markdown = ?, error_json = ?,
             started_at = ?, completed_at = ? WHERE block_run_id = ?`,
          input.run.status,
          input.run.markdown,
          input.run.error ? JSON.stringify(input.run.error) : null,
          input.run.startedAt ? Date.parse(input.run.startedAt) : null,
          input.run.completedAt ? Date.parse(input.run.completedAt) : null,
          input.run.id,
        );
        this.state.storage.sql.exec(
          `INSERT INTO hypersight_block_result_receipts
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
      if (accepted) {
        await this.broadcastHyperSightEvent({
          type: "hypersight_block_run_updated",
          occurredAt: new Date().toISOString(),
          run: input.run,
        });
      }
      return json({ accepted });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "hypersight_request_failed" }, 409);
    }
  }

  private async broadcastHyperSightEvent(
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
    const metadata = this.metadataRow();
    if (!metadata) return;
    const placeholders = [...activeUsers].map(() => "?").join(",");
    const members = await this.env.DB.prepare(
      `SELECT user_id FROM workspace_members
        WHERE workspace_id = ? AND status = 'active' AND user_id IN (${placeholders})`,
    ).bind(metadata.workspace_id, ...activeUsers).all<{ user_id: string }>();
    const permitted = new Set((members.results ?? []).map((member) => member.user_id)
      .filter((userId) => this.canRead(userId)));
    const payload = JSON.stringify(WorkstreamControlSocketEventSchema.parse(event));
    for (const socket of sockets) {
      const attachment = readSocketAttachment(socket);
      if (!attachment?.subscribed || !activeUsers.has(attachment.userId)) continue;
      if (!permitted.has(attachment.userId)) {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
        continue;
      }
      socket.send(payload);
    }
  }

  private async deliverHyperSightDispatches(limit = 10): Promise<void> {
    const rows = this.state.storage.sql.exec<{
      block_run_id: string;
      block_id: string;
      dispatch_json: string;
      attempts: number;
    }>(
      `SELECT block_run_id, block_id, dispatch_json, attempts
         FROM hypersight_dispatch_outbox WHERE not_before <= ?
        ORDER BY created_at, block_run_id LIMIT ?`,
      Date.now(),
      limit,
    ).toArray();
    for (const row of rows) {
      try {
        const dispatch = HyperSightBlockDispatchSchema.parse(JSON.parse(row.dispatch_json));
        const stub = await durableObjectStubForWorkspace(
          this.env,
          this.env.HYPERSIGHT_BLOCK_AGENTS,
          dispatch.workspaceId,
          hyperSightBlockAgentName(
            dispatch.region,
            dispatch.workspaceId,
            dispatch.workstreamId,
            dispatch.blockId,
          ),
        );
        const response = await stub.fetch("https://hypersight.internal/internal/run-dispatch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(dispatch),
        });
        if (!response.ok) throw new Error(`hypersight_dispatch_rejected:${response.status}`);
        this.state.storage.sql.exec(
          `DELETE FROM hypersight_dispatch_outbox WHERE block_run_id = ?`,
          row.block_run_id,
        );
      } catch {
        const attempts = row.attempts + 1;
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
        this.state.storage.sql.exec(
          `UPDATE hypersight_dispatch_outbox SET attempts = ?, not_before = ?
            WHERE block_run_id = ?`,
          attempts,
          Date.now() + delay,
          row.block_run_id,
        );
      }
    }
  }

  private queueHyperSightSourceRefresh(triggerSequence: number): void {
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO hypersight_source_refresh_outbox
         (id, trigger_sequence, attempts, not_before, created_at, updated_at)
       VALUES (1, ?, 0, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         trigger_sequence = MAX(hypersight_source_refresh_outbox.trigger_sequence,
                                excluded.trigger_sequence),
         attempts = 0,
         not_before = MIN(hypersight_source_refresh_outbox.not_before, excluded.not_before),
         updated_at = excluded.updated_at`,
      triggerSequence,
      now,
      now,
      now,
    );
  }

  private async deliverHyperSightSourceRefresh(): Promise<void> {
    const row = first(this.state.storage.sql.exec<{
      trigger_sequence: number;
      attempts: number;
    }>(
      `SELECT trigger_sequence, attempts FROM hypersight_source_refresh_outbox
        WHERE id = 1 AND not_before <= ?`,
      Date.now(),
    ));
    if (!row) return;
    const metadata = this.metadataRow();
    if (!metadata) return;
    try {
      const request = HyperSightSourceRefreshRequestSchema.parse({
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
          metadata.workspace_id,
          metadata.workstream_id,
        ),
      );
      const response = await stub.fetch(
        "https://substream.internal/internal/hypersight-refresh-request",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      if (!response.ok) throw new Error(`hypersight_source_refresh_rejected:${response.status}`);
      this.state.storage.sql.exec(
        `DELETE FROM hypersight_source_refresh_outbox
          WHERE id = 1 AND trigger_sequence = ?`,
        row.trigger_sequence,
      );
    } catch {
      const attempts = row.attempts + 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
      this.state.storage.sql.exec(
        `UPDATE hypersight_source_refresh_outbox
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
        this.applyChildEnvelope(parsed.data.substreamId, envelope);
        accepted += 1;
      }
      await this.armAlarm();
      await this.broadcastMetadata();
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
      if (metadata && (
        metadata.workspace_id !== envelope.workspaceId
        || metadata.workstream_id !== envelope.workstreamId
        || metadata.authority_generation !== envelope.generation
      )) throw new Error("workstream_effect_identity_mismatch");

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
      if (existing.payload_hash !== envelope.payloadHash) throw new Error("substream_projection_version_conflict");
      return;
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
      unreadCount: effects.reduce((count, effect) => count + effect.unreadCount, 0),
      youAreMentioned: effects.some((effect) => effect.youAreMentioned),
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
      `SELECT revision, authority_generation, workspace_id, workstream_id, title, description, preview,
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
      unreadCount: effects.reduce((count, effect) => count + effect.unreadCount, 0),
      youAreMentioned: effects.some((effect) => effect.youAreMentioned),
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

  private metadataForUser(userId: string): WorkstreamControlMetadata | null {
    const row = this.metadataRow();
    if (!row) return null;
    const viewer = this.userProjection(userId);
    const readThrough = viewer?.seenAttentionOrdinal ?? row.unread_tracking_start_ordinal;
    const nextPendingWakeup = row.next_wakeup_due_at && row.next_wakeup_prompt
      ? { dueAt: iso(row.next_wakeup_due_at), promptPreview: promptPreview(row.next_wakeup_prompt) }
      : null;
    return WorkstreamControlMetadataSchema.parse({
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
        readThroughSequenceNumber: readThrough,
        manualUnreadFromSequenceNumber: viewer?.manualUnreadFromOrdinal ?? null,
        manualUnreadGeneration: viewer?.manualUnreadGeneration ?? 0,
        latestMentionSequenceNumber: viewer?.latestMentionAttentionOrdinal ?? 0,
      },
    });
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
    const placeholders = [...activeUsers].map(() => "?").join(",");
    let permitted: Set<string>;
    try {
      const row = this.metadataRow();
      if (!row) throw new Error("workstream_metadata_missing");
      const result = await this.env.DB.prepare(
        `SELECT user_id FROM workspace_members
          WHERE workspace_id = ? AND status = 'active' AND user_id IN (${placeholders})`,
      ).bind(row.workspace_id, ...activeUsers).all<{ user_id: string }>();
      permitted = new Set((result.results ?? []).map((member) => member.user_id)
        .filter((userId) => this.canRead(userId)));
    } catch {
      for (const socket of sockets) socket.close(1011, "Reconnect to continue reading this work stream");
      return;
    }
    const occurredAt = new Date().toISOString();
    for (const socket of sockets) {
      const attachment = readSocketAttachment(socket);
      if (!attachment?.subscribed) continue;
      if (!permitted.has(attachment.userId)) {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
        continue;
      }
      const metadata = this.metadataForUser(attachment.userId);
      if (!metadata) continue;
      socket.send(JSON.stringify(WorkstreamControlSocketEventSchema.parse({
        type: "workstream_metadata",
        occurredAt,
        metadata,
      })));
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
    const messageId = crypto.randomUUID();
    // A pending complete replacement has not crossed the object boundary and
    // can be coalesced. An inflight row may already have committed at the
    // regional destination even if its response has not returned, so retain
    // and retry it until its idempotent acknowledgement arrives.
    this.state.storage.sql.exec(
      `DELETE FROM durable_outbox WHERE partition_key = ? AND state = 'pending'`,
      projectionKey,
    );
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

  private enqueueImmutable(substreamId: string, source: WorkstreamRegionalEffectEnvelope, now: number): void {
    let requiredProjectionVersion: number | null = null;
    if (source.effect.kind === "mention_notification") {
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
         (message_id, partition_key, source_version, source_epoch, payload_json, payload_hash,
          state, attempts, not_before, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       RETURNING message_id`,
      envelope.messageId,
      envelope.partitionKey,
      envelope.sourceVersion,
      envelope.generation,
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
        ORDER BY created_at, message_id LIMIT ?`,
      Date.now(),
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

  private async armAlarm(): Promise<void> {
    const next = this.nextAlarmAt();
    if (next === null) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing > next) await this.state.storage.setAlarm(next);
  }

  private nextAlarmAt(): number | null {
    const regional = first(this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM durable_outbox WHERE state IN ('pending', 'inflight')`,
    ))?.due_at ?? null;
    const hypersight = first(this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM hypersight_dispatch_outbox`,
    ))?.due_at ?? null;
    const sourceRefresh = first(this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM hypersight_source_refresh_outbox`,
    ))?.due_at ?? null;
    return [regional, hypersight, sourceRefresh].reduce<number | null>((earliest, candidate) => {
      if (candidate === null) return earliest;
      return earliest === null ? candidate : Math.min(earliest, candidate);
    }, null);
  }
}
