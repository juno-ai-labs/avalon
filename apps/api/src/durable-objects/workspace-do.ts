import {
  ClientSocketEventSchema,
  IdSchema,
  WorkstreamSocketCommandResultSchema,
} from "@avalon/contracts";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
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
  workstreamId: IdSchema,
  substreamId: z.union([z.literal("0"), IdSchema]),
  userId: IdSchema,
  sessionId: z.string().min(1).max(200),
  ticketId: z.string().uuid(),
  ticketExpiresAt: z.coerce.number().int().positive(),
});

type SocketIdentity = z.infer<typeof SocketIdentitySchema>;
type CreateMessageCommand = Extract<z.infer<typeof ClientSocketEventSchema>, { type: "create_message" }>;

interface WorkspaceSocketAttachment extends SocketIdentity {
  connectionId: string;
  connectedAt: string;
}

export const WORKSPACE_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "workspace identity and one-time command socket tickets",
  statements: [
    `CREATE TABLE workspace_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
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
    }).safeParse(socket.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * One regional command/control object per workspace.
 *
 * It accepts user writes over a hibernating workspace WebSocket and routes each
 * command to exactly one WorkstreamDO/SubstreamAgent branch. It stores no
 * transcript and runs no model. Durable state is explicit SQLite only.
 */
export class WorkspaceDO extends DurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly initialized: Promise<void>;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    this.state = state;
    this.initialized = state.blockConcurrencyWhile(async () => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: "workspace_do",
        workerVersionId: env.APP_VERSION ?? "unknown",
      });
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
    const parsed = ClientSocketEventSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.type !== "create_message") {
      socket.close(1008, "Only message creation is accepted by the workspace socket");
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

  private async acceptSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }
    const identity = SocketIdentitySchema.safeParse({
      workspaceId: request.headers.get("x-avalon-workspace-id"),
      workstreamId: request.headers.get("x-avalon-workstream-id"),
      substreamId: request.headers.get("x-avalon-substream-id"),
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
    this.ensureIdentity(identity.data.workspaceId);
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
    };
    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server, [attachment.userId]);
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
        attachment.workstreamId,
        attachment.substreamId,
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
          workstream_id: attachment.workstreamId,
          substream_id: attachment.substreamId,
          user_id: attachment.userId,
          client_message_id: command.payload.clientMessageId,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  }

  private ensureIdentity(workspaceId: string): void {
    const existing = this.workspaceId();
    if (existing && existing !== workspaceId) throw new Error("workspace_object_identity_mismatch");
    if (existing) return;
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO workspace_identity(id, workspace_id, region, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?)`,
      workspaceId,
      this.env.AVALON_REGION,
      now,
      now,
    );
  }

  private workspaceId(): string | null {
    return this.state.storage.sql.exec<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_identity WHERE id = 1`,
    ).toArray()[0]?.workspace_id ?? null;
  }

  private consumeSocketTicket(identity: SocketIdentity): boolean {
    const now = Math.floor(Date.now() / 1_000);
    if (identity.ticketExpiresAt <= now) return false;
    return this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `DELETE FROM socket_ticket_receipts WHERE expires_at < ?`,
        now - 300,
      );
      const inserted = this.state.storage.sql.exec<{ ticket_id: string }>(
        `INSERT OR IGNORE INTO socket_ticket_receipts
           (ticket_id, user_id, workstream_id, substream_id, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING ticket_id`,
        identity.ticketId,
        identity.userId,
        identity.workstreamId,
        identity.substreamId,
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
