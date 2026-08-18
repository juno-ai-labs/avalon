import {
  IdSchema,
  WORKSPACE_SYNC_TOPICS,
  WorkspaceSocketClientEventSchema,
  WorkspaceSocketSyncEventSchema,
  WorkspaceSyncTopicSchema,
  WorkstreamSocketCommandResultSchema,
  type WorkspaceSocketSyncEvent,
  type WorkspaceSyncTopic,
} from "@avalon/contracts";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  assertDurableObjectJurisdiction,
  fallbackWorkspacePlacementAffinity,
  isWorkspacePlacementAffinityForRegion,
  type WorkspacePlacementAffinity,
} from "../lib/durable-object-namespace";
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
  lastVersion: number;
}

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
      version INTEGER PRIMARY KEY AUTOINCREMENT,
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
      lastVersion: z.number().int().nonnegative(),
    }).safeParse(socket.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * One regional synchronization and command/control object per workspace.
 *
 * The Electron app keeps one hibernating socket here for workspace-wide query
 * invalidations and user writes. Message commands name their target branch;
 * workspace-owned product rows remain authoritative in regional D1, while the
 * monotonic invalidation log and socket receipts live in explicit local SQL.
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
        syncVersion: this.latestSyncVersion(),
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
      await this.subscribe(socket, attachment, parsed.data.afterVersion);
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
    const version = this.state.storage.transactionSync(() => {
      const row = this.state.storage.sql.exec<{ version: number }>(
        `INSERT INTO workspace_sync_events(topics_json, occurred_at)
         VALUES (?, ?) RETURNING version`,
        JSON.stringify(ordered),
        occurredAtMs,
      ).one();
      this.state.storage.sql.exec(
        `DELETE FROM workspace_sync_events WHERE version <= ?`,
        row.version - 1_024,
      );
      return row.version;
    });
    const event = WorkspaceSocketSyncEventSchema.parse({
      type: "workspace_sync",
      version,
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
        socket.serializeAttachment({ ...attachment, lastVersion: version });
      } catch {
        // The hibernation runtime owns close cleanup. A reconnect receives a
        // full invalidation or replays the bounded SQL log.
      }
    }
    return version;
  }

  /** Pin the workspace identity before any child object can be resolved. */
  async initializeWorkspace(
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<void> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
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
      connectionId: crypto.randomUUID(),
      connectedAt: new Date().toISOString(),
      subscribed: false,
      lastVersion: 0,
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

  private latestSyncVersion(): number {
    return this.state.storage.sql.exec<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM workspace_sync_events`,
    ).one().version;
  }

  private async subscribe(
    socket: WebSocket,
    attachment: WorkspaceSocketAttachment,
    afterVersion: number,
  ): Promise<void> {
    const latest = this.latestSyncVersion();
    const earliest = this.state.storage.sql.exec<{ version: number | null }>(
      `SELECT MIN(version) AS version FROM workspace_sync_events`,
    ).one().version;
    let events: WorkspaceSocketSyncEvent[];
    if (afterVersion === 0) {
      events = [{
        type: "workspace_sync",
        version: latest,
        occurredAt: new Date().toISOString(),
        topics: [...WORKSPACE_SYNC_TOPICS],
        reason: "initial",
      }];
    } else if (afterVersion > latest || (earliest !== null && afterVersion < earliest - 1)) {
      events = [{
        type: "workspace_sync",
        version: latest,
        occurredAt: new Date().toISOString(),
        topics: [...WORKSPACE_SYNC_TOPICS],
        reason: "history_unavailable",
      }];
    } else {
      events = this.state.storage.sql.exec<{
        version: number;
        topics_json: string;
        occurred_at: number;
      }>(
        `SELECT version, topics_json, occurred_at FROM workspace_sync_events
          WHERE version > ? ORDER BY version`,
        afterVersion,
      ).toArray().map((row) => WorkspaceSocketSyncEventSchema.parse({
        type: "workspace_sync",
        version: row.version,
        occurredAt: new Date(row.occurred_at).toISOString(),
        topics: JSON.parse(row.topics_json),
        reason: "change",
      }));
    }
    for (const event of events) socket.send(JSON.stringify(WorkspaceSocketSyncEventSchema.parse(event)));
    socket.serializeAttachment({
      ...attachment,
      subscribed: true,
      lastVersion: events.at(-1)?.version ?? Math.max(afterVersion, latest),
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
