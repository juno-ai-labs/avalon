import {
  IdSchema,
  WORKSPACE_SYNC_TOPICS,
  WorkspaceWorkstreamPageEventSchema,
  WorkspaceWorkstreamStateEventSchema,
  WorkspaceSocketClientEventSchema,
  WorkspaceSocketSyncEventSchema,
  WorkspaceSyncTopicSchema,
  WorkstreamSchema,
  WorkstreamSocketCommandResultSchema,
  type Workstream,
  type WorkspaceSocketSyncEvent,
  type WorkspaceSyncTopic,
} from "@avalon/contracts";
import { truncateUtf16Safe } from "@avalon/contracts/text";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  assertDurableObjectJurisdiction,
  fallbackWorkspacePlacementAffinity,
  isWorkspacePlacementAffinityForRegion,
  workspacePlacementAffinity,
  type WorkspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { logWarn } from "../observability/logger";
import {
  acceptsNewWorkstreamWork,
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";
import {
  WorkspaceDirectoryApplyRequestSchema,
  WorkspaceDirectoryExistsRequestSchema,
  WorkspaceDirectoryApplyResultSchema,
  WorkspaceDirectoryDueRequestSchema,
  WorkspaceDirectoryFeedbackRequestSchema,
  WorkspaceDirectoryFeedbackResultSchema,
  WorkspaceDirectoryImportPinsRequestSchema,
  WorkspaceDirectoryListRequestSchema,
  WorkspaceDirectoryLookupRequestSchema,
  WorkspaceDirectoryLookupResultSchema,
  WorkspaceDirectoryRecentRequestSchema,
  WorkspaceDirectoryNotificationRequestSchema,
  WorkspaceDirectoryNotificationStateSchema,
  WorkspaceDirectoryPageSchema,
  WorkspaceDirectoryPinRequestSchema,
  WorkspaceDirectoryPlannedRequestSchema,
  WorkspaceDirectoryReorderPinsRequestSchema,
  WorkspaceDirectoryResourceAccessRequestSchema,
  WorkspaceDirectoryResourceAccessResultSchema,
  WorkspaceDirectoryResourceRequestSchema,
  WorkspaceDirectoryResourceResultSchema,
  WorkspaceDirectoryRoutingCandidatesRequestSchema,
  WorkspaceDirectoryScheduleTargetsRequestSchema,
  WorkspaceDirectoryScheduleTargetsResultSchema,
  WorkspaceDirectoryVisibilityRequestSchema,
  WorkspaceDirectoryVisibleIdsRequestSchema,
  type WorkspaceDirectoryApplyRequest,
  type WorkspaceDirectoryApplyResult,
  type WorkspaceDirectoryDueRequest,
  type WorkspaceDirectoryExistsRequest,
  type WorkspaceDirectoryFeedbackRequest,
  type WorkspaceDirectoryFeedbackResult,
  type WorkspaceDirectoryImportPinsRequest,
  type WorkspaceDirectoryListRequest,
  type WorkspaceDirectoryLookupRequest,
  type WorkspaceDirectoryLookupResult,
  type WorkspaceDirectoryRecentRequest,
  type WorkspaceDirectoryPage,
  type WorkspaceDirectoryPinRequest,
  type WorkspaceDirectoryPlannedRequest,
  type WorkspaceDirectoryReorderPinsRequest,
  type WorkspaceDirectoryResourceAccessRequest,
  type WorkspaceDirectoryResourceAccessResult,
  type WorkspaceDirectoryNotificationRequest,
  type WorkspaceDirectoryNotificationState,
  type WorkspaceDirectoryResourceRequest,
  type WorkspaceDirectoryResourceResult,
  type WorkspaceDirectoryRoutingCandidatesRequest,
  type WorkspaceDirectoryScheduleTargetsRequest,
  type WorkspaceDirectoryScheduleTargetsResult,
  type WorkspaceDirectoryVisibilityRequest,
  type WorkspaceDirectoryVisibleIdsRequest,
} from "./workspace-directory-protocol";
import type { WorkstreamRegionalEffectEnvelope } from "./workstream-regional-effect";

const SocketIdentitySchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  sessionId: z.string().min(1).max(200),
  ticketId: z.string().uuid(),
  ticketExpiresAt: z.coerce.number().int().positive(),
});

type SocketIdentity = z.infer<typeof SocketIdentitySchema>;
type CreateMessageCommand = Extract<
  z.infer<typeof WorkspaceSocketClientEventSchema>,
  { type: "create_message" }
>;

interface WorkspaceSocketAttachment extends SocketIdentity {
  connectionId: string;
  connectedAt: string;
  subscribed: boolean;
  lastWaterline: number;
}

interface WorkspaceDirectoryRow extends Record<string, SqlStorageValue> {
  workstream_id: string;
  authority_generation: number;
  common_waterline: number;
  common_event_id: string;
  title: string;
  description: string;
  scope: "personal" | "workspace";
  exact_state: string;
  system_kind: "digest" | null;
  last_activity_at: number;
  completed_at: number | null;
  archived_at: number | null;
  email_address: string | null;
  origin_type: "ad_hoc" | "automation";
  origin_label: string | null;
  created_by_user_id: string | null;
  automation_subscription_id: string | null;
  automation_run_id: string | null;
  planned_for: number | null;
  title_status: "naming" | "automatic" | "settled";
  latest_attention_ordinal: number;
  unread_tracking_start_ordinal: number;
  next_wakeup_due_at: number | null;
  next_wakeup_prompt: string | null;
  source_created_at: number;
  source_updated_at: number;
  seen_attention_ordinal: number | null;
  manual_unread_from_ordinal: number | null;
  manual_unread_generation: number | null;
  latest_mention_attention_ordinal: number | null;
  is_participant: number | null;
  viewer_waterline: number | null;
  viewer_event_id: string | null;
  pin_position: number | null;
}

const MAX_WORKSPACE_PINS_PER_USER = 1_000;

export const WORKSPACE_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "workspace control-plane authority and realtime synchronization",
  statements: [
    `CREATE TABLE workspace_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      placement_affinity TEXT NOT NULL CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE socket_ticket_receipts (
      ticket_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL,
      substream_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX socket_ticket_receipts_expiry_idx
      ON socket_ticket_receipts(expires_at, ticket_id)`,
    `CREATE TABLE workspace_sync_events (
      waterline INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      topics_json TEXT NOT NULL CHECK (json_valid(topics_json) AND length(topics_json) <= 4096),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
    ) STRICT`,
    `CREATE TABLE workspace_socket_ticket_receipts (
      ticket_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX workspace_socket_ticket_receipts_expiry_idx
      ON workspace_socket_ticket_receipts(expires_at, ticket_id)`,
    `CREATE TABLE workspace_directory_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      waterline INTEGER NOT NULL CHECK (waterline >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT`,
    `INSERT INTO workspace_directory_state(id, waterline, updated_at) VALUES (1, 0, 0)`,
    `CREATE TABLE workspace_workstream_directory (
      workstream_id TEXT PRIMARY KEY,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(title) <= 500),
      description TEXT NOT NULL CHECK (length(description) <= 4000),
      preview TEXT NOT NULL CHECK (length(preview) <= 1000),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      exact_state TEXT NOT NULL CHECK (length(exact_state) BETWEEN 1 AND 80),
      system_kind TEXT CHECK (system_kind IS NULL OR length(system_kind) <= 80),
      last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= 0),
      completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
      email_address TEXT,
      origin_type TEXT NOT NULL CHECK (origin_type IN ('ad_hoc', 'automation')),
      origin_label TEXT CHECK (origin_label IS NULL OR length(origin_label) <= 120),
      created_by_user_id TEXT,
      automation_subscription_id TEXT,
      automation_run_id TEXT,
      planned_for INTEGER CHECK (planned_for IS NULL OR planned_for >= 0),
      title_status TEXT NOT NULL CHECK (title_status IN ('naming', 'automatic', 'settled')),
      latest_attention_ordinal INTEGER NOT NULL CHECK (latest_attention_ordinal >= 0),
      unread_tracking_start_ordinal INTEGER NOT NULL CHECK (unread_tracking_start_ordinal >= 0),
      next_wakeup_due_at INTEGER CHECK (next_wakeup_due_at IS NULL OR next_wakeup_due_at >= 0),
      next_wakeup_prompt TEXT CHECK (next_wakeup_prompt IS NULL OR length(next_wakeup_prompt) <= 500),
      next_terminal_action_at INTEGER CHECK (next_terminal_action_at IS NULL OR next_terminal_action_at >= 0),
      source_created_at INTEGER NOT NULL CHECK (source_created_at >= 0),
      source_updated_at INTEGER NOT NULL CHECK (source_updated_at >= 0),
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_directory_list_idx
      ON workspace_workstream_directory(archived_at, system_kind, last_activity_at DESC, workstream_id)`,
    `CREATE INDEX workspace_workstream_directory_automation_idx
      ON workspace_workstream_directory(automation_subscription_id, planned_for, archived_at)`,
    `CREATE INDEX workspace_workstream_directory_due_idx
      ON workspace_workstream_directory(next_wakeup_due_at, next_terminal_action_at, workstream_id)`,
    `CREATE TABLE workspace_workstream_viewers (
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      is_participant INTEGER NOT NULL CHECK (is_participant IN (0, 1)),
      unread_count INTEGER NOT NULL CHECK (unread_count >= 0),
      you_are_mentioned INTEGER NOT NULL CHECK (you_are_mentioned IN (0, 1)),
      listable INTEGER NOT NULL CHECK (listable IN (0, 1)),
      seen_attention_ordinal INTEGER NOT NULL CHECK (seen_attention_ordinal >= 0),
      manual_unread_from_ordinal INTEGER CHECK (manual_unread_from_ordinal IS NULL OR manual_unread_from_ordinal >= 0),
      manual_unread_generation INTEGER NOT NULL CHECK (manual_unread_generation >= 0),
      latest_mention_attention_ordinal INTEGER NOT NULL CHECK (latest_mention_attention_ordinal >= 0),
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      PRIMARY KEY (workstream_id, user_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_viewers_interest_idx
      ON workspace_workstream_viewers(user_id, listable, you_are_mentioned, unread_count, workstream_id)`,
    `CREATE TABLE workspace_workstream_pins (
      user_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (user_id, workstream_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_pins_order_idx
      ON workspace_workstream_pins(user_id, position, workstream_id)`,
    `CREATE TABLE workspace_workstream_resource_links (
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      watch_enabled INTEGER NOT NULL CHECK (watch_enabled IN (0, 1)),
      relationship_type TEXT NOT NULL CHECK (length(relationship_type) BETWEEN 1 AND 80),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      PRIMARY KEY (workstream_id, resource_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_resource_links_lookup_idx
      ON workspace_workstream_resource_links(resource_id, watch_enabled, workstream_id)`,
    `CREATE TABLE workspace_workstream_suggestion_feedback (
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      action_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('contextual_routing', 'suggested_work')),
      status TEXT NOT NULL CHECK (status IN ('accepted', 'dismissed')),
      resolved_at INTEGER NOT NULL CHECK (resolved_at >= 0),
      resolved_by_user_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      PRIMARY KEY (workstream_id, action_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_suggestion_feedback_activity_idx
      ON workspace_workstream_suggestion_feedback(source, status, resolved_at, activity_id)`,
    `CREATE TABLE workspace_workstream_effect_receipts (
      message_id TEXT PRIMARY KEY,
      workstream_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL CHECK (received_at >= 0)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_effect_receipts_received_idx
      ON workspace_workstream_effect_receipts(received_at, message_id)`,
    `CREATE TRIGGER workspace_identity_placement_valid_insert
      BEFORE INSERT ON workspace_identity
      WHEN NEW.placement_affinity IS NULL
        OR (NEW.region = 'global' AND NEW.placement_affinity NOT IN ('wnam', 'enam'))
        OR (NEW.region = 'eu' AND NEW.placement_affinity NOT IN ('weur', 'eeur'))
      BEGIN
        SELECT RAISE(ABORT, 'workspace_placement_affinity_invalid');
      END`,
    `CREATE TRIGGER workspace_identity_placement_valid_update
      BEFORE UPDATE OF placement_affinity ON workspace_identity
      WHEN NEW.placement_affinity IS NULL
        OR (NEW.region = 'global' AND NEW.placement_affinity NOT IN ('wnam', 'enam'))
        OR (NEW.region = 'eu' AND NEW.placement_affinity NOT IN ('weur', 'eeur'))
      BEGIN
        SELECT RAISE(ABORT, 'workspace_placement_affinity_invalid');
      END`,
    `CREATE TRIGGER workspace_identity_placement_immutable
      BEFORE UPDATE OF placement_affinity ON workspace_identity
      WHEN OLD.placement_affinity IS NOT NULL
        AND NEW.placement_affinity <> OLD.placement_affinity
      BEGIN
        SELECT RAISE(ABORT, 'workspace_placement_affinity_immutable');
      END`,
  ],
}];

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function readAttachment(socket: WebSocket): WorkspaceSocketAttachment | null {
  try {
    const parsed = SocketIdentitySchema.extend({
      connectionId: z.string().uuid(),
      connectedAt: z.string().datetime({ offset: true }),
      subscribed: z.boolean(),
      lastWaterline: z.number().int().nonnegative(),
    }).safeParse(socket.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function epoch(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("workspace_directory_timestamp_invalid");
  return parsed;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function directoryCursor(value: string): { lastActivityAt: number; workstreamId: string } {
  const separator = value.indexOf(":");
  const lastActivityAt = Number(value.slice(0, separator));
  const workstreamId = value.slice(separator + 1);
  if (!Number.isSafeInteger(lastActivityAt) || lastActivityAt < 0 || !workstreamId) {
    throw new Error("workspace_directory_cursor_invalid");
  }
  return { lastActivityAt, workstreamId };
}

function workstreamHarnessStatus(state: string): Workstream["harnessStatus"] {
  if (state === "scheduled") return "scheduled";
  if (["running", "interrupting", "preparing_context", "waiting_capacity"].includes(state)) {
    return "running";
  }
  if (state === "needs_input") return "needs_input";
  if (state === "completed") return "completed";
  if (["failed", "budget_exhausted"].includes(state)) return "failed";
  return "idle";
}

function directoryWorkstream(row: WorkspaceDirectoryRow, workspaceId: string): Workstream {
  const latest = Number(row.latest_attention_ordinal);
  const seen = row.seen_attention_ordinal === null
    ? Number(row.unread_tracking_start_ordinal)
    : Number(row.seen_attention_ordinal);
  const manual = row.manual_unread_from_ordinal === null
    ? null
    : Number(row.manual_unread_from_ordinal);
  const firstUnread = manual ?? (latest > seen ? Math.min(latest, seen + 1) : null);
  const titleStatus = row.title_status === "naming"
    && Date.now() - row.source_created_at > 60_000
    ? "automatic"
    : row.title_status;
  return WorkstreamSchema.parse({
    id: row.workstream_id,
    workspaceId,
    title: truncateUtf16Safe(row.title, 180),
    titleStatus,
    objective: truncateUtf16Safe(row.description, 4_000),
    emailAddress: row.email_address,
    originType: row.origin_type,
    originLabel: row.origin_label,
    createdByUserId: row.created_by_user_id,
    automationSubscriptionId: row.automation_subscription_id,
    automationRunId: row.automation_run_id,
    plannedFor: iso(row.planned_for),
    harnessStatus: workstreamHarnessStatus(row.exact_state),
    latestAttentionSequenceNumber: latest,
    readThroughSequenceNumber: seen,
    manualUnreadFromSequenceNumber: manual,
    manualUnreadGeneration: Number(row.manual_unread_generation ?? 0),
    hasUnread: firstUnread !== null,
    youAreMentioned: Number(row.latest_mention_attention_ordinal ?? 0) > seen,
    firstUnreadSequenceNumber: firstUnread,
    lastActivityAt: iso(row.last_activity_at),
    createdAt: iso(row.source_created_at),
    updatedAt: iso(row.source_updated_at),
    archivedAt: iso(row.archived_at),
    scope: row.scope,
    systemKind: row.system_kind,
    nextPendingWakeup: row.next_wakeup_due_at !== null && row.next_wakeup_prompt
      ? {
          dueAt: iso(row.next_wakeup_due_at),
          promptPreview: truncateUtf16Safe(row.next_wakeup_prompt.replace(/\s+/gu, " ").trim(), 40),
        }
      : null,
    pinPosition: row.pin_position,
  });
}

function directoryStateVersion(row: WorkspaceDirectoryRow) {
  return {
    workstreamId: row.workstream_id,
    commonEventId: row.common_event_id,
    viewerEventId: row.viewer_event_id,
    authorityGeneration: row.authority_generation,
    commonWaterline: row.common_waterline,
    viewerWaterline: row.viewer_waterline ?? 0,
  };
}

function internalDirectoryItem(row: WorkspaceDirectoryRow) {
  return {
    workstreamId: row.workstream_id,
    title: row.title,
    description: row.description,
    scope: row.scope,
    state: row.exact_state,
    systemKind: row.system_kind,
    lastActivityAt: iso(row.last_activity_at),
    archivedAt: iso(row.archived_at),
    updatedAt: iso(row.source_updated_at),
    originType: row.origin_type,
    originLabel: row.origin_label,
    createdByUserId: row.created_by_user_id,
    automationSubscriptionId: row.automation_subscription_id,
    automationRunId: row.automation_run_id,
    plannedFor: iso(row.planned_for),
  };
}

const SELECT_WORKSPACE_DIRECTORY = `SELECT directory.workstream_id,
    directory.authority_generation, directory.waterline AS common_waterline,
    directory.source_event_id AS common_event_id, directory.title,
    directory.description, directory.scope, directory.exact_state,
    directory.system_kind, directory.last_activity_at, directory.completed_at,
    directory.archived_at, directory.email_address, directory.origin_type,
    directory.origin_label, directory.created_by_user_id,
    directory.automation_subscription_id, directory.automation_run_id,
    directory.planned_for, directory.title_status,
    directory.latest_attention_ordinal, directory.unread_tracking_start_ordinal,
    directory.next_wakeup_due_at, directory.next_wakeup_prompt,
    directory.source_created_at, directory.source_updated_at,
    viewer.seen_attention_ordinal, viewer.manual_unread_from_ordinal,
    viewer.manual_unread_generation, viewer.latest_mention_attention_ordinal,
    viewer.is_participant, viewer.waterline AS viewer_waterline,
    viewer.source_event_id AS viewer_event_id, pin.position AS pin_position
  FROM workspace_workstream_directory directory
  LEFT JOIN workspace_workstream_viewers viewer
    ON viewer.workstream_id = directory.workstream_id
   AND viewer.user_id = ?
   AND viewer.authority_generation = directory.authority_generation
  LEFT JOIN workspace_workstream_pins pin
    ON pin.workstream_id = directory.workstream_id AND pin.user_id = ?`;

/**
 * One regional synchronization and command/control object per workspace.
 *
 * The Electron app keeps one hibernating socket here for workspace-wide query
 * invalidations, directory pages, and user writes. Message commands name their
 * target branch. WorkspaceDO SQL is authoritative for cross-workstream serving
 * state; regional D1 retains only identity, routing, migration, and the
 * workspace modules that have not yet moved behind a Durable Object boundary.
 */
export class WorkspaceDO extends DurableObject<Env> {
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
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: "workspace_do",
        workerVersionId: env.APP_VERSION ?? "unknown",
      });
      state.storage.sql.exec(
        `UPDATE workspace_identity SET placement_affinity = ?
          WHERE id = 1 AND placement_affinity IS NULL`,
        fallbackWorkspacePlacementAffinity(env.AVALON_REGION),
      );
    });
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
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
        role: "workspace-control",
        workspaceId: this.workspaceId(),
        placementAffinity: this.placementAffinity(),
        syncWaterline: this.latestSyncWaterline(),
        databaseBytes: this.state.storage.sql.databaseSize,
      });
    }
    return json({ error: "not_found" }, 404);
  }

  override async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.initialized;
    const attachment = readAttachment(socket);
    if (!attachment) {
      socket.close(1011, "Missing workspace connection identity");
      return;
    }
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      socket.close(1008, "Workspace commands must be JSON");
      return;
    }
    const parsed = WorkspaceSocketClientEventSchema.safeParse(decoded);
    if (!parsed.success) {
      socket.close(1008, "Invalid workspace socket event");
      return;
    }
    if (parsed.data.type === "subscribe") {
      const auth = await this.sessionAuth(attachment);
      if (!auth) {
        socket.close(1008, "Session no longer active");
        return;
      }
      await this.subscribe(socket, attachment, parsed.data.afterWaterline);
      return;
    }
    if (parsed.data.type === "list_workstreams") {
      const auth = await this.sessionAuth(attachment);
      if (!auth) {
        socket.close(1008, "Session no longer active");
        return;
      }
      const page = this.listDirectory({
        workspaceId: attachment.workspaceId,
        userId: attachment.userId,
        limit: parsed.data.limit,
        ...(parsed.data.before ? { before: parsed.data.before } : {}),
        includeSystem: parsed.data.includeSystem,
      });
      socket.send(JSON.stringify(WorkspaceWorkstreamPageEventSchema.parse({
        type: "workspace_workstream_page",
        requestId: parsed.data.requestId,
        ...page,
      })));
      return;
    }
    await this.createMessage(socket, attachment, parsed.data);
  }

  override webSocketClose(): void {
    // Hibernating sockets carry all durable identity in their attachment.
  }

  override webSocketError(): void {
    // The client reconnects with a new one-time ticket when it still has work.
  }

  /**
   * Record and fan out a workspace-owned surface change. This RPC is called by
   * authenticated HTTP mutations and regional background consumers only; the
   * socket itself never lets a desktop manufacture an invalidation.
   */
  async publishSync(
    topics: WorkspaceSyncTopic[],
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<number> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
    const parsed = z.array(WorkspaceSyncTopicSchema).min(1).safeParse(topics);
    if (!parsed.success) throw new Error("invalid_workspace_sync_topics");
    const requested = new Set(parsed.data);
    const ordered = WORKSPACE_SYNC_TOPICS.filter((topic) => requested.has(topic));
    const occurredAtMs = Date.now();
    const occurredAt = new Date(occurredAtMs).toISOString();
    const eventId = uuidV7(occurredAtMs);
    const waterline = this.state.storage.transactionSync(() => {
      const row = this.state.storage.sql.exec<{ waterline: number }>(
        `INSERT INTO workspace_sync_events(event_id, topics_json, occurred_at)
         VALUES (?, ?, ?) RETURNING waterline`,
        eventId,
        JSON.stringify(ordered),
        occurredAtMs,
      ).one();
      this.state.storage.sql.exec(
        `DELETE FROM workspace_sync_events WHERE waterline <= ?`,
        row.waterline - 1_024,
      );
      return row.waterline;
    });
    const event = WorkspaceSocketSyncEventSchema.parse({
      type: "workspace_sync",
      eventId,
      waterline,
      occurredAt,
      topics: ordered,
      reason: "change",
    });
    const payload = JSON.stringify(event);
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      try {
        socket.send(payload);
        socket.serializeAttachment({ ...attachment, lastWaterline: waterline });
      } catch {
        // The hibernation runtime owns close cleanup. A reconnect receives a
        // full invalidation or replays the bounded SQL log.
      }
    }
    return waterline;
  }

  /** Pin the workspace identity before any child object can be resolved. */
  async initializeWorkspace(
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<void> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
  }

  /** Commit WorkstreamDO-owned facts into the workspace's authoritative directory. */
  async applyWorkstreamDirectoryEffects(
    input: WorkspaceDirectoryApplyRequest,
  ): Promise<WorkspaceDirectoryApplyResult> {
    await this.initialized;
    const request = WorkspaceDirectoryApplyRequestSchema.parse(input);
    if (!this.workspaceId()) {
      this.ensureIdentity(
        request.workspaceId,
        await workspacePlacementAffinity(this.env, request.workspaceId),
      );
    }
    this.assertWorkspace(request.workspaceId);
    const userIds = [...new Set(request.envelopes.flatMap((envelope) => (
      envelope.effect.kind === "directory_user" ? [envelope.effect.userId] : []
    )))];
    const activeUsers = new Set<string>();
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      const members = await this.env.DB.prepare(
        `SELECT user_id FROM workspace_members
          WHERE workspace_id = ? AND status = 'active' AND user_id IN (${placeholders})`,
      ).bind(request.workspaceId, ...userIds).all<{ user_id: string }>();
      for (const member of members.results ?? []) activeUsers.add(member.user_id);
    }
    const subscriptionIds = [...new Set(request.envelopes.flatMap((envelope) => (
      envelope.effect.kind === "directory_common" && envelope.effect.automationSubscriptionId
        ? [envelope.effect.automationSubscriptionId]
        : []
    )))];
    const originLabels = new Map<string, string>();
    if (subscriptionIds.length > 0) {
      const placeholders = subscriptionIds.map(() => "?").join(",");
      const labels = await this.env.DB.prepare(
        `SELECT subscription.id, template.name
           FROM automation_subscriptions subscription
           JOIN automation_templates template ON template.id = subscription.template_id
          WHERE subscription.workspace_id = ? AND subscription.id IN (${placeholders})`,
      ).bind(request.workspaceId, ...subscriptionIds).all<{ id: string; name: string }>();
      for (const label of labels.results ?? []) {
        originLabels.set(label.id, truncateUtf16Safe(label.name, 120));
      }
    }
    let directoryChanged = false;
    const commonChanges = new Set<string>();
    const viewerChanges = new Map<string, Set<string>>();
    const accepted: WorkspaceDirectoryApplyResult["accepted"] = [];
    for (const envelope of request.envelopes) {
      const changed = this.applyDirectoryEnvelope(envelope, activeUsers, originLabels);
      directoryChanged = directoryChanged || changed;
      if (changed && envelope.effect.kind === "directory_common") {
        commonChanges.add(envelope.workstreamId);
      } else if (changed && envelope.effect.kind === "directory_user") {
        const users = viewerChanges.get(envelope.workstreamId) ?? new Set<string>();
        users.add(envelope.effect.userId);
        viewerChanges.set(envelope.workstreamId, users);
      }
      accepted.push({ messageId: envelope.messageId, payloadHash: envelope.payloadHash });
    }
    if (directoryChanged) {
      await Promise.all([
        ...commonChanges,
      ].map((workstreamId) => this.publishWorkstreamState(workstreamId)));
      await Promise.all([...viewerChanges].flatMap(([workstreamId, users]) => (
        commonChanges.has(workstreamId)
          ? []
          : [...users].map((userId) => this.publishWorkstreamState(workstreamId, userId))
      )));
    }
    return WorkspaceDirectoryApplyResultSchema.parse({ accepted, directoryChanged });
  }

  async listWorkstreams(input: WorkspaceDirectoryListRequest): Promise<WorkspaceDirectoryPage> {
    await this.initialized;
    const request = WorkspaceDirectoryListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceDirectoryPageSchema.parse(this.listDirectory(request));
  }

  async canReadWorkstream(input: WorkspaceDirectoryVisibilityRequest): Promise<boolean> {
    await this.initialized;
    const request = WorkspaceDirectoryVisibilityRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.directoryVisible(request.userId, request.workstreamId);
  }

  async visibleWorkstreamIds(input: WorkspaceDirectoryVisibleIdsRequest): Promise<string[]> {
    await this.initialized;
    const request = WorkspaceDirectoryVisibleIdsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id FROM workspace_workstream_directory directory
       LEFT JOIN workspace_workstream_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.archived_at IS NULL
         AND (? = 1 OR directory.system_kind IS NULL)
         AND ((? = 0 AND directory.scope = 'workspace') OR viewer.is_participant = 1)
       ORDER BY directory.workstream_id`,
      request.userId,
      request.includeSystem ? 1 : 0,
      request.participantsOnly ? 1 : 0,
    ).toArray().map((row) => row.workstream_id);
  }

  /** Maintenance fence used before a D1 route may advertise an active child. */
  async hasWorkstreamDirectory(input: WorkspaceDirectoryExistsRequest): Promise<boolean> {
    await this.initialized;
    const request = WorkspaceDirectoryExistsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return Boolean(this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM workspace_workstream_directory WHERE workstream_id = ?`,
      request.workstreamId,
    ).toArray()[0]);
  }

  async plannedWorkstream(input: WorkspaceDirectoryPlannedRequest): Promise<Workstream | null> {
    await this.initialized;
    const request = WorkspaceDirectoryPlannedRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const viewerId = request.userId ?? "";
    const row = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.automation_subscription_id = ?
         AND directory.planned_for = ? AND directory.archived_at IS NULL
         AND (? IS NULL OR directory.scope = 'workspace' OR viewer.is_participant = 1)
       ORDER BY directory.source_updated_at DESC, directory.workstream_id LIMIT 1`,
      viewerId,
      viewerId,
      request.automationSubscriptionId,
      epoch(request.plannedFor),
      request.userId,
    ).toArray()[0];
    return row ? directoryWorkstream(row, request.workspaceId) : null;
  }

  async pinWorkstream(input: WorkspaceDirectoryPinRequest): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryPinRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!this.directoryVisible(request.userId, request.workstreamId)) {
      throw new Error("workstream_not_found");
    }
    const now = Date.now();
    const changed = this.state.storage.transactionSync(() => {
      const alreadyPinned = this.state.storage.sql.exec<{ one: number }>(
        `SELECT 1 AS one FROM workspace_workstream_pins
          WHERE user_id = ? AND workstream_id = ?`,
        request.userId,
        request.workstreamId,
      ).toArray().length === 1;
      if (!alreadyPinned) {
        const count = this.state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM workspace_workstream_pins WHERE user_id = ?`,
          request.userId,
        ).one().count;
        if (count >= MAX_WORKSPACE_PINS_PER_USER) throw new Error("workstream_pin_limit_reached");
      }
      const inserted = this.state.storage.sql.exec<{ workstream_id: string }>(
        `INSERT OR IGNORE INTO workspace_workstream_pins
           (user_id, workstream_id, position, created_at, updated_at)
         VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM workspace_workstream_pins
                                  WHERE user_id = ?), 0), ?, ?)
         RETURNING workstream_id`,
        request.userId,
        request.workstreamId,
        request.userId,
        now,
        now,
      ).toArray().length === 1;
      if (inserted) this.advanceDirectoryVersion(now);
      return inserted;
    });
    if (changed) await this.publishDirectorySync(request.workspaceId);
    return { items: this.pinnedDirectoryRows(request.userId, true).map((row) => (
      directoryWorkstream(row, request.workspaceId)
    )) };
  }

  async unpinWorkstream(input: WorkspaceDirectoryPinRequest): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryPinRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const now = Date.now();
    const changed = this.state.storage.transactionSync(() => {
      const removed = this.state.storage.sql.exec<{ workstream_id: string }>(
        `DELETE FROM workspace_workstream_pins
          WHERE user_id = ? AND workstream_id = ? RETURNING workstream_id`,
        request.userId,
        request.workstreamId,
      ).toArray().length === 1;
      if (removed) {
        this.rewritePinOrder(request.userId, [], now);
        this.advanceDirectoryVersion(now);
      }
      return removed;
    });
    if (changed) await this.publishDirectorySync(request.workspaceId);
    return { items: this.pinnedDirectoryRows(request.userId, true).map((row) => (
      directoryWorkstream(row, request.workspaceId)
    )) };
  }

  async reorderWorkstreamPins(
    input: WorkspaceDirectoryReorderPinsRequest,
  ): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryReorderPinsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.rewritePinOrder(request.userId, request.workstreamIds, now);
      this.advanceDirectoryVersion(now);
    });
    await this.publishDirectorySync(request.workspaceId);
    return { items: this.pinnedDirectoryRows(request.userId, true).map((row) => (
      directoryWorkstream(row, request.workspaceId)
    )) };
  }

  /** Maintenance-only import of the existing per-user pin order. */
  async importWorkstreamPins(input: WorkspaceDirectoryImportPinsRequest): Promise<number> {
    await this.initialized;
    const request = WorkspaceDirectoryImportPinsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!["maintenance_importing", "maintenance_verified"].includes(authority.phase)) {
      throw new Error("workspace_directory_pin_import_phase_mismatch");
    }
    if (!this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM workspace_workstream_directory WHERE workstream_id = ?`,
      request.workstreamId,
    ).toArray()[0]) throw new Error("workspace_directory_pin_import_workstream_missing");
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      for (const pin of request.pins) {
        const existing = this.state.storage.sql.exec<{ one: number }>(
          `SELECT 1 AS one FROM workspace_workstream_pins
            WHERE user_id = ? AND workstream_id = ?`,
          pin.userId,
          request.workstreamId,
        ).toArray().length === 1;
        if (!existing) {
          const count = this.state.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM workspace_workstream_pins WHERE user_id = ?`,
            pin.userId,
          ).one().count;
          if (count >= MAX_WORKSPACE_PINS_PER_USER) {
            throw new Error("workstream_pin_import_limit_exceeded");
          }
        }
        this.state.storage.sql.exec(
          `INSERT INTO workspace_workstream_pins
             (user_id, workstream_id, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, workstream_id) DO UPDATE SET
             position = excluded.position, created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
          pin.userId,
          request.workstreamId,
          pin.position,
          epoch(pin.createdAt),
          epoch(pin.updatedAt),
        );
      }
      if (request.pins.length > 0) this.advanceDirectoryVersion(now);
    });
    return request.pins.length;
  }

  async notificationDirectoryState(
    input: WorkspaceDirectoryNotificationRequest,
  ): Promise<WorkspaceDirectoryNotificationState | null> {
    await this.initialized;
    const request = WorkspaceDirectoryNotificationRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{
      authority_generation: number;
      waterline: number;
      listable: number;
      title: string;
      email_address: string | null;
    }>(
      `SELECT directory.authority_generation, viewer.waterline,
              viewer.listable, directory.title, directory.email_address
         FROM workspace_workstream_directory directory
         JOIN workspace_workstream_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?
          AND viewer.authority_generation = directory.authority_generation
        WHERE directory.workstream_id = ? AND directory.archived_at IS NULL`,
      request.userId,
      request.workstreamId,
    ).toArray()[0];
    return row ? WorkspaceDirectoryNotificationStateSchema.parse({
      authorityGeneration: row.authority_generation,
      viewerVersion: row.waterline,
      listable: row.listable === 1,
      title: row.title,
      emailAddress: row.email_address,
    }) : null;
  }

  async workstreamsForResource(
    input: WorkspaceDirectoryResourceRequest,
  ): Promise<WorkspaceDirectoryResourceResult> {
    await this.initialized;
    const request = WorkspaceDirectoryResourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT link.workstream_id FROM workspace_workstream_resource_links link
       JOIN workspace_workstream_directory directory
         ON directory.workstream_id = link.workstream_id
       WHERE link.resource_id = ? AND directory.archived_at IS NULL
         AND (? = 0 OR link.watch_enabled = 1)
       ORDER BY link.workstream_id`,
      request.resourceId,
      request.watchedOnly ? 1 : 0,
    ).toArray();
    return WorkspaceDirectoryResourceResultSchema.parse({
      workstreamIds: rows.map((row) => row.workstream_id),
    });
  }

  /** Internal cross-workstream lookup; never exposes viewer-specific state. */
  async lookupWorkstreamDirectory(
    input: WorkspaceDirectoryLookupRequest,
  ): Promise<WorkspaceDirectoryLookupResult> {
    await this.initialized;
    const request = WorkspaceDirectoryLookupRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const placeholders = request.workstreamIds.map(() => "?").join(",");
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.workstream_id IN (${placeholders})
       ORDER BY directory.last_activity_at DESC, directory.workstream_id`,
      "",
      "",
      ...request.workstreamIds,
    ).toArray();
    return WorkspaceDirectoryLookupResultSchema.parse({
      items: rows.map(internalDirectoryItem),
    });
  }

  async recentWorkstreamDirectory(
    input: WorkspaceDirectoryRecentRequest,
  ): Promise<WorkspaceDirectoryLookupResult> {
    await this.initialized;
    const request = WorkspaceDirectoryRecentRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const viewerId = request.userId ?? "";
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL
         AND (? = 1 OR directory.system_kind IS NULL)
         AND (? IS NULL OR ((? = 0 AND directory.scope = 'workspace') OR viewer.is_participant = 1))
       ORDER BY directory.last_activity_at DESC, directory.workstream_id LIMIT ?`,
      viewerId,
      viewerId,
      request.includeSystem ? 1 : 0,
      request.userId,
      request.participantsOnly ? 1 : 0,
      request.limit,
    ).toArray();
    return WorkspaceDirectoryLookupResultSchema.parse({ items: rows.map(internalDirectoryItem) });
  }

  async dueWorkstreamDirectory(input: WorkspaceDirectoryDueRequest): Promise<string[]> {
    await this.initialized;
    const request = WorkspaceDirectoryDueRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const column = request.kind === "terminal" ? "next_terminal_action_at" : "next_wakeup_due_at";
    return this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT workstream_id FROM workspace_workstream_directory
        WHERE archived_at IS NULL AND ${column} IS NOT NULL AND ${column} <= ?
        ORDER BY ${column}, workstream_id LIMIT ?`,
      epoch(request.through),
      request.limit,
    ).toArray().map((row) => row.workstream_id);
  }

  async workstreamScheduleTargets(
    input: WorkspaceDirectoryScheduleTargetsRequest,
  ): Promise<WorkspaceDirectoryScheduleTargetsResult> {
    await this.initialized;
    const request = WorkspaceDirectoryScheduleTargetsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{
      kind: "wakeup" | "terminal";
      workstream_id: string;
      due_at: number;
    }>(
      `SELECT 'terminal' AS kind, workstream_id, next_terminal_action_at AS due_at
         FROM workspace_workstream_directory
        WHERE archived_at IS NULL AND next_terminal_action_at IS NOT NULL
       ORDER BY due_at, workstream_id`,
    ).toArray();
    return WorkspaceDirectoryScheduleTargetsResultSchema.parse({
      items: rows.map((row) => ({
        kind: row.kind,
        workstreamId: row.workstream_id,
        dueAt: iso(row.due_at),
      })),
    });
  }

  async routingCandidates(
    input: WorkspaceDirectoryRoutingCandidatesRequest,
  ): Promise<WorkspaceDirectoryLookupResult> {
    await this.initialized;
    const request = WorkspaceDirectoryRoutingCandidatesRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const restrictedJson = request.restrictedUserIds === null
      ? null
      : JSON.stringify(request.restrictedUserIds);
    const excludedJson = JSON.stringify(request.excludedWorkstreamIds);
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL
         AND directory.system_kind IS NULL
         AND directory.exact_state IN ('idle', 'running', 'interrupting', 'preparing_context',
                                       'waiting_capacity', 'needs_input', 'scheduled')
         AND (? IS NULL OR directory.created_by_user_id IN (SELECT value FROM json_each(?))
           OR EXISTS (
             SELECT 1 FROM workspace_workstream_viewers allowed
              WHERE allowed.workstream_id = directory.workstream_id
                AND allowed.authority_generation = directory.authority_generation
                AND allowed.user_id IN (SELECT value FROM json_each(?))
                AND allowed.is_participant = 1
           ))
         AND (
           SELECT COUNT(*) FROM workspace_workstream_suggestion_feedback dismissed
            WHERE dismissed.workstream_id = directory.workstream_id
              AND dismissed.source = 'contextual_routing'
              AND dismissed.status = 'dismissed'
              AND dismissed.resolved_at >= ?
              AND dismissed.resolved_at > COALESCE((
                SELECT MAX(accepted.resolved_at)
                  FROM workspace_workstream_suggestion_feedback accepted
                 WHERE accepted.workstream_id = directory.workstream_id
                   AND accepted.source = 'contextual_routing'
                   AND accepted.status = 'accepted'
              ), 0)
         ) < ?
         AND directory.workstream_id NOT IN (SELECT value FROM json_each(?))
       ORDER BY directory.last_activity_at DESC, directory.workstream_id
       LIMIT ?`,
      "",
      "",
      restrictedJson,
      restrictedJson,
      restrictedJson,
      epoch(request.feedbackSince),
      request.dismissalLimit,
      excludedJson,
      request.limit,
    ).toArray();
    return WorkspaceDirectoryLookupResultSchema.parse({ items: rows.map(internalDirectoryItem) });
  }

  async suggestionFeedback(
    input: WorkspaceDirectoryFeedbackRequest,
  ): Promise<WorkspaceDirectoryFeedbackResult> {
    await this.initialized;
    const request = WorkspaceDirectoryFeedbackRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{
      workstream_id: string;
      activity_id: string;
      status: "accepted" | "dismissed";
      resolved_at: number;
      resolved_by_user_id: string;
    }>(
      `SELECT workstream_id, activity_id, status, resolved_at, resolved_by_user_id
         FROM workspace_workstream_suggestion_feedback
        WHERE source = ? AND resolved_at >= ?
        ORDER BY resolved_at, workstream_id, action_id`,
      request.source,
      epoch(request.since),
    ).toArray();
    return WorkspaceDirectoryFeedbackResultSchema.parse({
      items: rows.map((row) => ({
        workstreamId: row.workstream_id,
        activityId: row.activity_id,
        status: row.status,
        resolvedAt: iso(row.resolved_at),
        resolvedByUserId: row.resolved_by_user_id || null,
      })),
    });
  }

  async resourceAccess(
    input: WorkspaceDirectoryResourceAccessRequest,
  ): Promise<WorkspaceDirectoryResourceAccessResult> {
    await this.initialized;
    const request = WorkspaceDirectoryResourceAccessRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{
      workstream_id: string;
      scope: "personal" | "workspace";
      created_by_user_id: string | null;
      automation_subscription_id: string | null;
      is_participant: number;
    }>(
      `SELECT directory.workstream_id, directory.scope, directory.created_by_user_id,
              directory.automation_subscription_id,
              COALESCE(viewer.is_participant, 0) AS is_participant
         FROM workspace_workstream_resource_links link
         JOIN workspace_workstream_directory directory
           ON directory.workstream_id = link.workstream_id
         LEFT JOIN workspace_workstream_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?
          AND viewer.authority_generation = directory.authority_generation
        WHERE link.resource_id = ? AND directory.archived_at IS NULL
        ORDER BY directory.workstream_id`,
      request.userId,
      request.resourceId,
    ).toArray();
    return WorkspaceDirectoryResourceAccessResultSchema.parse({
      items: rows.map((row) => ({
        workstreamId: row.workstream_id,
        scope: row.scope,
        createdByUserId: row.created_by_user_id,
        automationSubscriptionId: row.automation_subscription_id,
        isParticipant: row.is_participant === 1,
      })),
    });
  }

  private async acceptSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }
    const identity = SocketIdentitySchema.safeParse({
      workspaceId: request.headers.get("x-avalon-workspace-id"),
      userId: request.headers.get("x-avalon-user-id"),
      sessionId: request.headers.get("x-avalon-session-id"),
      ticketId: request.headers.get("x-avalon-socket-ticket-id"),
      ticketExpiresAt: request.headers.get("x-avalon-socket-ticket-expires-at"),
    });
    if (!identity.success) return json({ error: "invalid_socket_identity" }, 400);

    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority) || authority.phase !== "durable_object_open") {
      return json({ error: "workstream_maintenance", phase: authority.phase }, 503);
    }
    const placementAffinity = request.headers.get("x-avalon-placement-affinity");
    if (!isWorkspacePlacementAffinityForRegion(this.env.AVALON_REGION, placementAffinity)) {
      return json({ error: "invalid_workspace_placement_affinity" }, 400);
    }
    this.ensureIdentity(identity.data.workspaceId, placementAffinity);
    if (!this.consumeSocketTicket(identity.data)) {
      return json({ error: "socket_ticket_replayed" }, 401);
    }
    const auth = await this.sessionAuth(identity.data);
    if (!auth) return json({ error: "session_revoked" }, 401);

    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) return json({ error: "websocket_unavailable" }, 500);
    const attachment: WorkspaceSocketAttachment = {
      ...identity.data,
      connectionId: uuidV7(),
      connectedAt: new Date().toISOString(),
      subscribed: false,
      lastWaterline: 0,
    };
    this.state.acceptWebSocket(server, [attachment.workspaceId, attachment.userId]);
    // Register the server end with the hibernation API before attaching the
    // state that handlers will recover after an isolate wake. Both operations
    // are synchronous, so no client event can interleave between them.
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async createMessage(
    socket: WebSocket,
    attachment: WorkspaceSocketAttachment,
    command: CreateMessageCommand,
  ): Promise<void> {
    try {
      const authority = await readWorkstreamAuthorityControl(this.env);
      if (!acceptsNewWorkstreamWork(authority) || authority.phase !== "durable_object_open") {
        throw new ApiError(503, "workstream_maintenance", "Work streams are temporarily unavailable");
      }
      const auth = await this.sessionAuth(attachment);
      if (!auth) {
        socket.close(1008, "Session no longer active");
        return;
      }
      const result = await new WorkstreamObjectClient(
        this.env,
        auth,
        command.workstreamId,
        command.substreamId,
      ).createMessage({
        ...command.payload,
        telemetryOperationId: command.operationId,
      });
      socket.send(JSON.stringify(WorkstreamSocketCommandResultSchema.parse({
        type: "client_command_succeeded",
        command: "create_message",
        clientMessageId: command.payload.clientMessageId,
        ...result,
      })));
    } catch (error) {
      const safe = error instanceof ApiError
        ? error
        : new ApiError(500, "message_write_failed", "The message could not be sent");
      socket.send(JSON.stringify(WorkstreamSocketCommandResultSchema.parse({
        type: "client_command_failed",
        command: "create_message",
        clientMessageId: command.payload.clientMessageId,
        error: {
          status: safe.status,
          code: safe.code,
          message: safe.message,
          ...(safe.details ? { details: safe.details } : {}),
        },
      })));
      if (!(error instanceof ApiError)) {
        logWarn(this.env, "workspace_socket_create_message_failed", {
          workspace_id: attachment.workspaceId,
          workstream_id: command.workstreamId,
          substream_id: command.substreamId,
          user_id: attachment.userId,
          client_message_id: command.payload.clientMessageId,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  }

  private applyDirectoryEnvelope(
    envelope: WorkstreamRegionalEffectEnvelope,
    activeUsers: ReadonlySet<string>,
    originLabels: ReadonlyMap<string, string>,
  ): boolean {
    return this.state.storage.transactionSync(() => {
      const receipt = this.state.storage.sql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM workspace_workstream_effect_receipts WHERE message_id = ?`,
        envelope.messageId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.payload_hash !== envelope.payloadHash) {
          throw new Error("workspace_directory_effect_idempotency_conflict");
        }
        return false;
      }

      const now = Date.now();
      let changed = false;
      if (envelope.effect.kind === "directory_common") {
        const current = this.state.storage.sql.exec<{
          authority_generation: number;
          waterline: number;
          payload_hash: string;
        }>(
          `SELECT authority_generation, waterline, payload_hash
             FROM workspace_workstream_directory WHERE workstream_id = ?`,
          envelope.workstreamId,
        ).toArray()[0];
        const applies = !current
          || envelope.generation > current.authority_generation
          || (envelope.generation === current.authority_generation
            && envelope.sourceVersion > current.waterline);
        if (current
          && envelope.generation === current.authority_generation
          && envelope.sourceVersion === current.waterline
          && envelope.payloadHash !== current.payload_hash) {
          throw new Error("workspace_directory_projection_version_conflict");
        }
        if (applies) {
          const effect = envelope.effect;
          const originLabel = effect.automationSubscriptionId
            ? originLabels.get(effect.automationSubscriptionId) ?? null
            : null;
          this.state.storage.sql.exec(
            `INSERT INTO workspace_workstream_directory
               (workstream_id, authority_generation, waterline, source_event_id, payload_hash,
                title, description, preview, scope, exact_state, system_kind,
                last_activity_at, completed_at, archived_at, email_address,
                origin_type, origin_label, created_by_user_id,
                automation_subscription_id, automation_run_id, planned_for,
                title_status, latest_attention_ordinal,
                unread_tracking_start_ordinal, next_wakeup_due_at,
                next_wakeup_prompt, next_terminal_action_at, source_created_at,
                source_updated_at, projected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workstream_id) DO UPDATE SET
               authority_generation = excluded.authority_generation,
               waterline = excluded.waterline,
               source_event_id = excluded.source_event_id,
               payload_hash = excluded.payload_hash,
               title = excluded.title, description = excluded.description,
               preview = excluded.preview, scope = excluded.scope,
               exact_state = excluded.exact_state, system_kind = excluded.system_kind,
               last_activity_at = excluded.last_activity_at,
               completed_at = excluded.completed_at, archived_at = excluded.archived_at,
               email_address = excluded.email_address, origin_type = excluded.origin_type,
               origin_label = excluded.origin_label,
               created_by_user_id = excluded.created_by_user_id,
               automation_subscription_id = excluded.automation_subscription_id,
               automation_run_id = excluded.automation_run_id,
               planned_for = excluded.planned_for, title_status = excluded.title_status,
               latest_attention_ordinal = excluded.latest_attention_ordinal,
               unread_tracking_start_ordinal = excluded.unread_tracking_start_ordinal,
               next_wakeup_due_at = excluded.next_wakeup_due_at,
               next_wakeup_prompt = excluded.next_wakeup_prompt,
               next_terminal_action_at = excluded.next_terminal_action_at,
               source_created_at = excluded.source_created_at,
               source_updated_at = excluded.source_updated_at,
               projected_at = excluded.projected_at`,
            envelope.workstreamId,
            envelope.generation,
            envelope.sourceVersion,
            envelope.messageId,
            envelope.payloadHash,
            effect.title,
            effect.description,
            effect.preview,
            effect.scope,
            effect.state,
            effect.systemKind,
            epoch(effect.lastActivityAt),
            epoch(effect.completedAt),
            epoch(effect.archivedAt),
            effect.emailAddress ?? null,
            effect.originType ?? "ad_hoc",
            originLabel,
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
            now,
          );
          this.state.storage.sql.exec(
            `DELETE FROM workspace_workstream_resource_links WHERE workstream_id = ?`,
            envelope.workstreamId,
          );
          for (const link of effect.resourceLinks ?? []) {
            this.state.storage.sql.exec(
              `INSERT INTO workspace_workstream_resource_links
                 (workstream_id, resource_id, watch_enabled, relationship_type,
                  authority_generation, waterline, source_event_id, projected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              envelope.workstreamId,
              link.resourceId,
              link.watchEnabled ? 1 : 0,
              link.relationshipType,
              envelope.generation,
              envelope.sourceVersion,
              envelope.messageId,
              now,
            );
          }
          changed = true;
        }
      } else if (envelope.effect.kind === "directory_user") {
        const effect = envelope.effect;
        const current = this.state.storage.sql.exec<{
          authority_generation: number;
          waterline: number;
          payload_hash: string;
        }>(
          `SELECT authority_generation, waterline, payload_hash
             FROM workspace_workstream_viewers WHERE workstream_id = ? AND user_id = ?`,
          envelope.workstreamId,
          effect.userId,
        ).toArray()[0];
        if (!activeUsers.has(effect.userId)) {
          changed = this.state.storage.sql.exec<{ user_id: string }>(
            `DELETE FROM workspace_workstream_viewers
              WHERE workstream_id = ? AND user_id = ? RETURNING user_id`,
            envelope.workstreamId,
            effect.userId,
          ).toArray().length === 1;
        } else {
          const applies = !current
            || envelope.generation > current.authority_generation
            || (envelope.generation === current.authority_generation
              && envelope.sourceVersion > current.waterline);
          if (current
            && envelope.generation === current.authority_generation
            && envelope.sourceVersion === current.waterline
            && envelope.payloadHash !== current.payload_hash) {
            throw new Error("workspace_directory_viewer_version_conflict");
          }
          if (applies) {
            this.state.storage.sql.exec(
              `INSERT INTO workspace_workstream_viewers
                 (workstream_id, user_id, authority_generation, waterline,
                  source_event_id, payload_hash, is_participant, unread_count, you_are_mentioned,
                  listable, seen_attention_ordinal, manual_unread_from_ordinal,
                  manual_unread_generation, latest_mention_attention_ordinal,
                  projected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(workstream_id, user_id) DO UPDATE SET
                 authority_generation = excluded.authority_generation,
                 waterline = excluded.waterline,
                 source_event_id = excluded.source_event_id,
                 payload_hash = excluded.payload_hash,
                 is_participant = excluded.is_participant,
                 unread_count = excluded.unread_count,
                 you_are_mentioned = excluded.you_are_mentioned,
                 listable = excluded.listable,
                 seen_attention_ordinal = excluded.seen_attention_ordinal,
                 manual_unread_from_ordinal = excluded.manual_unread_from_ordinal,
                 manual_unread_generation = excluded.manual_unread_generation,
                 latest_mention_attention_ordinal = excluded.latest_mention_attention_ordinal,
                 projected_at = excluded.projected_at`,
              envelope.workstreamId,
              effect.userId,
              envelope.generation,
              envelope.sourceVersion,
              envelope.messageId,
              envelope.payloadHash,
              effect.isParticipant ? 1 : 0,
              effect.unreadCount,
              effect.youAreMentioned ? 1 : 0,
              effect.listable ? 1 : 0,
              effect.seenAttentionOrdinal ?? 0,
              effect.manualUnreadFromOrdinal ?? null,
              effect.manualUnreadGeneration ?? 0,
              effect.latestMentionAttentionOrdinal ?? 0,
              now,
            );
            changed = true;
          }
        }
      } else if (envelope.effect.kind === "suggestion_feedback") {
        const effect = envelope.effect;
        const current = this.state.storage.sql.exec<{
          authority_generation: number;
          waterline: number;
        }>(
          `SELECT authority_generation, waterline
             FROM workspace_workstream_suggestion_feedback
            WHERE workstream_id = ? AND action_id = ?`,
          envelope.workstreamId,
          effect.actionId,
        ).toArray()[0];
        if (!current
          || envelope.generation > current.authority_generation
          || (envelope.generation === current.authority_generation
            && envelope.sourceVersion > current.waterline)) {
          this.state.storage.sql.exec(
            `INSERT INTO workspace_workstream_suggestion_feedback
               (workstream_id, action_id, activity_id, source, status, resolved_at,
                resolved_by_user_id, authority_generation, waterline, source_event_id, projected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workstream_id, action_id) DO UPDATE SET
               activity_id = excluded.activity_id, source = excluded.source,
               status = excluded.status, resolved_at = excluded.resolved_at,
               resolved_by_user_id = excluded.resolved_by_user_id,
               authority_generation = excluded.authority_generation,
               waterline = excluded.waterline,
               source_event_id = excluded.source_event_id,
               projected_at = excluded.projected_at`,
            envelope.workstreamId,
            effect.actionId,
            effect.activityId,
            effect.source,
            effect.status,
            epoch(effect.resolvedAt),
            effect.resolvedByUserId,
            envelope.generation,
            envelope.sourceVersion,
            envelope.messageId,
            now,
          );
        }
      }

      this.state.storage.sql.exec(
        `INSERT INTO workspace_workstream_effect_receipts
           (message_id, workstream_id, payload_hash, received_at)
         VALUES (?, ?, ?, ?)`,
        envelope.messageId,
        envelope.workstreamId,
        envelope.payloadHash,
        now,
      );
      if (changed) this.advanceDirectoryVersion(now);
      return changed;
    });
  }

  private listDirectory(request: WorkspaceDirectoryListRequest): WorkspaceDirectoryPage {
    const cursor = request.before ? directoryCursor(request.before) : null;
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL AND pin.user_id IS NULL
         AND (? = 1 OR directory.system_kind IS NULL)
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
         AND (? IS NULL OR directory.last_activity_at < ?
              OR (directory.last_activity_at = ? AND directory.workstream_id > ?))
       ORDER BY directory.last_activity_at DESC, directory.workstream_id LIMIT ?`,
      request.userId,
      request.userId,
      request.includeSystem ? 1 : 0,
      cursor?.lastActivityAt ?? null,
      cursor?.lastActivityAt ?? 0,
      cursor?.lastActivityAt ?? 0,
      cursor?.workstreamId ?? "",
      request.limit + 1,
    ).toArray();
    const hasMore = rows.length > request.limit;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    const nextCursor = hasMore && last
      ? `${last.last_activity_at}:${last.workstream_id}`
      : null;
    if (!request.before) rows.push(...this.pinnedDirectoryRows(request.userId, request.includeSystem));
    return {
      items: rows.map((row) => directoryWorkstream(row, request.workspaceId)),
      stateVersions: rows.map(directoryStateVersion),
      nextCursor,
      directoryWaterline: this.directoryWaterline(),
    };
  }

  private pinnedDirectoryRows(userId: string, includeSystem: boolean): WorkspaceDirectoryRow[] {
    return this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL AND pin.user_id IS NOT NULL
         AND (? = 1 OR directory.system_kind IS NULL)
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
       ORDER BY pin.position, directory.workstream_id`,
      userId,
      userId,
      includeSystem ? 1 : 0,
    ).toArray();
  }

  private directoryVisible(userId: string, workstreamId: string): boolean {
    return this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM workspace_workstream_directory directory
       LEFT JOIN workspace_workstream_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.workstream_id = ? AND directory.archived_at IS NULL
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)`,
      userId,
      workstreamId,
    ).toArray().length === 1;
  }

  private rewritePinOrder(userId: string, requestedIds: string[], now: number): void {
    const current = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT workstream_id FROM workspace_workstream_pins
        WHERE user_id = ? ORDER BY position, workstream_id`,
      userId,
    ).toArray().map((row) => row.workstream_id);
    const pinned = new Set(current);
    const requested = [...new Set(requestedIds)].filter((id) => pinned.has(id));
    const requestedSet = new Set(requested);
    const ordered = [...requested, ...current.filter((id) => !requestedSet.has(id))];
    for (const [position, workstreamId] of ordered.entries()) {
      this.state.storage.sql.exec(
        `UPDATE workspace_workstream_pins SET position = ?, updated_at = ?
          WHERE user_id = ? AND workstream_id = ?`,
        position,
        now,
        userId,
        workstreamId,
      );
    }
  }

  private directoryWaterline(): number {
    return this.state.storage.sql.exec<{ waterline: number }>(
      `SELECT waterline FROM workspace_directory_state WHERE id = 1`,
    ).one().waterline;
  }

  private advanceDirectoryVersion(now: number): void {
    this.state.storage.sql.exec(
      `UPDATE workspace_directory_state SET waterline = waterline + 1, updated_at = ? WHERE id = 1`,
      now,
    );
  }

  /** Push the current row; missed intermediate rows are intentionally irrelevant. */
  private async publishWorkstreamState(workstreamId: string, targetUserId?: string): Promise<void> {
    const occurredAt = new Date().toISOString();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      if (targetUserId && attachment.userId !== targetUserId) continue;
      const row = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
        `${SELECT_WORKSPACE_DIRECTORY}
         WHERE directory.workstream_id = ?`,
        attachment.userId,
        attachment.userId,
        workstreamId,
      ).toArray()[0];
      if (!row) continue;
      const visible = row.archived_at === null
        && (row.scope === "workspace" || row.is_participant === 1);
      const stateVersion = directoryStateVersion(row);
      const payload = JSON.stringify(WorkspaceWorkstreamStateEventSchema.parse({
        type: "workspace_workstream_state",
        occurredAt,
        workstreamId,
        stateVersion: {
          commonEventId: stateVersion.commonEventId,
          viewerEventId: stateVersion.viewerEventId,
          authorityGeneration: stateVersion.authorityGeneration,
          commonWaterline: stateVersion.commonWaterline,
          viewerWaterline: stateVersion.viewerWaterline,
        },
        workstream: visible ? directoryWorkstream(row, attachment.workspaceId) : null,
      }));
      try {
        socket.send(payload);
      } catch {
        // Hibernation owns close cleanup; reconnect loads the current page and
        // does not need the state rows missed while this socket was unhealthy.
      }
    }
  }

  private async publishDirectorySync(workspaceId: string): Promise<void> {
    const placementAffinity = this.placementAffinity();
    if (!placementAffinity) throw new Error("workspace_object_placement_affinity_missing");
    await this.publishSync(["workstream_directory"], workspaceId, placementAffinity);
  }

  private assertWorkspace(workspaceId: string): void {
    if (this.workspaceId() !== workspaceId) throw new Error("workspace_object_identity_mismatch");
  }

  private ensureIdentity(
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): void {
    const existing = this.workspaceId();
    if (existing && existing !== workspaceId) throw new Error("workspace_object_identity_mismatch");
    const existingAffinity = this.placementAffinity();
    if (existing) {
      if (existingAffinity !== placementAffinity) {
        throw new Error("workspace_object_placement_affinity_mismatch");
      }
      return;
    }
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      workspaceId,
      this.env.AVALON_REGION,
      placementAffinity,
      now,
      now,
    );
  }

  private workspaceId(): string | null {
    return this.state.storage.sql.exec<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_identity WHERE id = 1`,
    ).toArray()[0]?.workspace_id ?? null;
  }

  private placementAffinity(): WorkspacePlacementAffinity | null {
    const value = this.state.storage.sql.exec<{ placement_affinity: string | null }>(
      `SELECT placement_affinity FROM workspace_identity WHERE id = 1`,
    ).toArray()[0]?.placement_affinity;
    return isWorkspacePlacementAffinityForRegion(this.env.AVALON_REGION, value) ? value : null;
  }

  private latestSyncWaterline(): number {
    return this.state.storage.sql.exec<{ waterline: number }>(
      `SELECT COALESCE(MAX(waterline), 0) AS waterline FROM workspace_sync_events`,
    ).one().waterline;
  }

  private async subscribe(
    socket: WebSocket,
    attachment: WorkspaceSocketAttachment,
    afterWaterline: number,
  ): Promise<void> {
    const latest = this.latestSyncWaterline();
    const earliest = this.state.storage.sql.exec<{ waterline: number | null }>(
      `SELECT MIN(waterline) AS waterline FROM workspace_sync_events`,
    ).one().waterline;
    let events: WorkspaceSocketSyncEvent[];
    if (afterWaterline === 0) {
      events = [{
        type: "workspace_sync",
        eventId: uuidV7(),
        waterline: latest,
        occurredAt: new Date().toISOString(),
        topics: [...WORKSPACE_SYNC_TOPICS],
        reason: "initial",
      }];
    } else if (afterWaterline > latest || (earliest !== null && afterWaterline < earliest - 1)) {
      events = [{
        type: "workspace_sync",
        eventId: uuidV7(),
        waterline: latest,
        occurredAt: new Date().toISOString(),
        topics: [...WORKSPACE_SYNC_TOPICS],
        reason: "history_unavailable",
      }];
    } else {
      const rows = this.state.storage.sql.exec<{
        waterline: number;
        event_id: string;
        topics_json: string;
        occurred_at: number;
      }>(
        `SELECT waterline, event_id, topics_json, occurred_at FROM workspace_sync_events
          WHERE waterline > ? ORDER BY waterline`,
        afterWaterline,
      ).toArray();
      const newest = rows.at(-1);
      const changedTopics = new Set<WorkspaceSyncTopic>();
      for (const row of rows) {
        for (const topic of z.array(WorkspaceSyncTopicSchema).parse(JSON.parse(row.topics_json))) {
          changedTopics.add(topic);
        }
      }
      events = newest ? [WorkspaceSocketSyncEventSchema.parse({
        type: "workspace_sync",
        eventId: newest.event_id,
        waterline: newest.waterline,
        occurredAt: new Date(newest.occurred_at).toISOString(),
        topics: WORKSPACE_SYNC_TOPICS.filter((topic) => changedTopics.has(topic)),
        reason: "change",
      })] : [];
    }
    for (const event of events) socket.send(JSON.stringify(WorkspaceSocketSyncEventSchema.parse(event)));
    socket.serializeAttachment({
      ...attachment,
      subscribed: true,
      lastWaterline: events.at(-1)?.waterline ?? Math.max(afterWaterline, latest),
    });
  }

  private consumeSocketTicket(identity: SocketIdentity): boolean {
    const now = Math.floor(Date.now() / 1_000);
    if (identity.ticketExpiresAt <= now) return false;
    return this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `DELETE FROM workspace_socket_ticket_receipts WHERE expires_at < ?`,
        now - 300,
      );
      const inserted = this.state.storage.sql.exec<{ ticket_id: string }>(
        `INSERT OR IGNORE INTO workspace_socket_ticket_receipts
           (ticket_id, user_id, expires_at, consumed_at)
         VALUES (?, ?, ?, ?)
         RETURNING ticket_id`,
        identity.ticketId,
        identity.userId,
        identity.ticketExpiresAt,
        now,
      );
      return inserted.toArray().length === 1;
    });
  }

  private async sessionAuth(identity: Pick<SocketIdentity, "sessionId" | "userId" | "workspaceId">): Promise<AuthContext | null> {
    const role = this.env.APP_ENV === "development"
      && this.env.AVALON_DEV_AUTH === "true"
      && identity.sessionId === "development"
      ? await this.env.DB.prepare(
        `SELECT member.role
           FROM workspace_members member
           JOIN workspaces workspace ON workspace.id = member.workspace_id
          WHERE member.workspace_id = ? AND member.user_id = ?
            AND member.status = 'active' AND workspace.region = ?`,
      ).bind(identity.workspaceId, identity.userId, this.env.AVALON_REGION)
        .first<{ role: AuthContext["role"] }>()
      : await this.env.DB.prepare(
        `SELECT member.role
           FROM sessions session
           JOIN workspace_members member
             ON member.workspace_id = session.workspace_id
            AND member.user_id = session.user_id
            AND member.status = 'active'
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
}
