import {
  ClientSocketEventSchema,
  IdSchema,
  ServerSocketEventSchema,
  WorkstreamDetailSchema,
  type ServerSocketEvent,
  type User,
  type WorkstreamDetail
} from "@avalon/contracts";
import { z } from "zod";

import type { Env } from "../env";

const SocketAttachmentSchema = z.object({
  connectionId: z.string().uuid(),
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  userId: IdSchema,
  connectedAt: z.string().datetime({ offset: true }),
  afterSequence: z.number().int().nonnegative(),
  subscribed: z.boolean().default(false)
});

const BroadcastRequestSchema = z.object({ event: z.unknown() });
const RoomIdentitySchema = z.object({ workspaceId: IdSchema, workstreamId: IdSchema });
const SOCKET_TICKET_PREFIX = "socket-ticket:";
const MAX_REPLAY_EVENTS = 256;
const MAX_REPLAY_BYTES = 512_000;

type SocketAttachment = z.infer<typeof SocketAttachmentSchema>;

interface WorkstreamRow {
  id: string;
  workspace_id: string;
  title: string;
  objective: string;
  email_address: string | null;
  origin_type: "ad_hoc" | "automation";
  created_by_user_id: string | null;
  automation_subscription_id: string | null;
  automation_run_id: string | null;
  planned_for: string | null;
  harness_status: WorkstreamDetail["harnessStatus"];
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at: string;
}

const textEncoder = new TextEncoder();

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function userFromRow(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at
  };
}

export function workstreamRoomName(
  region: "global" | "eu",
  workspaceId: string,
  workstreamId: string
): string {
  return `${region}:${workspaceId}:${workstreamId}`;
}

export async function consumeSocketTicket(
  storage: DurableObjectStorage,
  ticketId: string,
  expiresAt: number,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): Promise<boolean> {
  if (expiresAt <= nowEpochSeconds) return false;
  const key = `${SOCKET_TICKET_PREFIX}${ticketId}`;
  const consumed = await storage.transaction(async (transaction) => {
    if (await transaction.get<number>(key)) return false;
    await transaction.put(key, expiresAt);
    return true;
  });
  if (consumed) {
    const entries = await storage.list<number>({ prefix: SOCKET_TICKET_PREFIX, limit: 32 });
    const expired = [...entries.entries()]
      .filter(([, expiration]) => expiration <= nowEpochSeconds)
      .map(([entryKey]) => entryKey);
    if (expired.length) await storage.delete(expired);
  }
  return consumed;
}

export function distinctNonParticipantViewers<T extends { userId: string; connectedAt: string }>(
  attachments: T[],
  participantIds: ReadonlySet<string>,
): T[] {
  const firstByUser = new Map<string, T>();
  for (const attachment of attachments) {
    if (participantIds.has(attachment.userId)) continue;
    const existing = firstByUser.get(attachment.userId);
    if (!existing || attachment.connectedAt < existing.connectedAt) {
      firstByUser.set(attachment.userId, attachment);
    }
  }
  return [...firstByUser.values()];
}

export type SocketReplayPlan =
  | { type: "snapshot" }
  | { type: "replay"; events: ServerSocketEvent[] }
  | { type: "resync_required"; reason: "history_unavailable" | "sequence_ahead" };

/**
 * The replay window intentionally lives only in object memory. Persisting every
 * token event would turn an ephemeral optimization into storage write cost.
 * After hibernation, clients receive an explicit resync instruction and use
 * canonical REST/D1 state instead.
 */
export function planSocketReplay(
  afterSequence: number,
  currentSequence: number,
  replayFloorSequence: number | null,
  recentEvents: readonly ServerSocketEvent[],
  allowInitialSnapshot = true,
): SocketReplayPlan {
  if (afterSequence === 0 && allowInitialSnapshot) return { type: "snapshot" };
  if (afterSequence > currentSequence) {
    return { type: "resync_required", reason: "sequence_ahead" };
  }
  if (afterSequence === currentSequence) return { type: "replay", events: [] };
  if (replayFloorSequence === null || afterSequence < replayFloorSequence) {
    return { type: "resync_required", reason: "history_unavailable" };
  }
  const events = recentEvents.filter((event) => event.sequence > afterSequence);
  if (events.length === 0 || events.at(-1)?.sequence !== currentSequence) {
    return { type: "resync_required", reason: "history_unavailable" };
  }
  return { type: "replay", events };
}

/**
 * A hibernating, non-canonical realtime coordinator for one work stream.
 *
 * REST/D1 remain authoritative. This object only allocates a total order for
 * live events, publishes canonical snapshots, and tracks socket presence.
 */
export class WorkstreamRoom {
  private readonly recentEvents: ServerSocketEvent[] = [];
  private recentEventBytes = 0;
  private replayFloorSequence: number | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
    // Exact text ping/pong frames are answered by the runtime without waking a
    // hibernated object, so keepalives do not accrue Durable Object duration.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/socket" || url.pathname === "/")) {
      return this.connect(request, url);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/internal/events" || url.pathname === "/events")
    ) {
      return this.acceptEvent(request);
    }

    if (request.method === "GET" && url.pathname === "/presence") {
      const identity = RoomIdentitySchema.safeParse(await this.state.storage.get("roomIdentity"));
      if (!identity.success) return jsonResponse({ viewers: [] });
      return jsonResponse({
        viewers: await this.loadViewers(identity.data.workspaceId, identity.data.workstreamId),
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, sockets: this.state.getWebSockets().length });
    }

    return jsonResponse({ error: "not_found" }, 404);
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let decoded: unknown;

    try {
      decoded = JSON.parse(raw);
    } catch {
      await this.sendError(socket, "invalid_json", "Socket messages must be JSON.");
      return;
    }

    const parsed = ClientSocketEventSchema.safeParse(decoded);
    if (!parsed.success) {
      await this.sendError(socket, "invalid_event", "The socket event is not valid.");
      return;
    }

    const attachment = this.readAttachment(socket);
    if (!attachment) {
      socket.close(1011, "Missing connection identity");
      return;
    }

    if (parsed.data.type === "subscribe") {
      await this.fulfillSubscription(
        socket,
        attachment.workspaceId,
        attachment.workstreamId,
        parsed.data.afterSequence,
      );
      await this.broadcastPresence(attachment.workspaceId, attachment.workstreamId);
      return;
    }

    // Product mutations are intentionally persisted and authorized through the
    // REST service before their resulting canonical event is published here.
    await this.sendError(
      socket,
      "rest_required",
      "Persist this action through the work-stream API before publishing it."
    );
  }

  async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    void code;
    void reason;
    void wasClean;
    const attachment = this.readAttachment(socket);
    if (attachment?.subscribed) {
      await this.broadcastPresence(attachment.workspaceId, attachment.workstreamId, socket);
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = this.readAttachment(socket);
    try {
      socket.close(1011, "Realtime connection failed");
    } catch {
      // The peer may already be gone; presence cleanup still needs to run.
    }
    if (attachment?.subscribed) {
      await this.broadcastPresence(attachment.workspaceId, attachment.workstreamId, socket);
    }
  }

  private async connect(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "websocket_upgrade_required" }, 426);
    }

    const identity = z
      .object({
        workspaceId: IdSchema,
        workstreamId: IdSchema,
        userId: IdSchema,
        ticketId: z.string().uuid(),
        ticketExpiresAt: z.coerce.number().int().positive(),
        afterSequence: z.coerce.number().int().nonnegative().default(0)
      })
      .safeParse({
        workspaceId:
          request.headers.get("x-avalon-workspace-id") ?? url.searchParams.get("workspaceId"),
        workstreamId:
          request.headers.get("x-avalon-workstream-id") ?? url.searchParams.get("workstreamId"),
        userId: request.headers.get("x-avalon-user-id") ?? url.searchParams.get("userId"),
        ticketId: request.headers.get("x-avalon-socket-ticket-id"),
        ticketExpiresAt: request.headers.get("x-avalon-socket-ticket-expires-at"),
        afterSequence: url.searchParams.get("afterSequence") ?? 0
      });

    if (!identity.success) return jsonResponse({ error: "invalid_socket_identity" }, 400);

    const authorized = await this.env.DB.prepare(
      `SELECT 1
         FROM workstreams w
         JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
         LEFT JOIN automation_subscriptions automation ON automation.id = w.automation_subscription_id
        WHERE w.id = ?1
          AND w.workspace_id = ?2
          AND wm.user_id = ?3
          AND wm.status = 'active'
          AND w.archived_at IS NULL
          AND (
            w.automation_subscription_id IS NULL
            OR automation.scope = 'workspace'
            OR automation.owner_user_id = ?3
            OR EXISTS (
              SELECT 1 FROM workstream_participants participant
              WHERE participant.workstream_id = w.id
                AND participant.user_id = ?3
                AND participant.removed_at IS NULL
            )
          )
        LIMIT 1`
    )
      .bind(identity.data.workstreamId, identity.data.workspaceId, identity.data.userId)
      .first();

    if (!authorized) return jsonResponse({ error: "forbidden" }, 403);

    if (!await consumeSocketTicket(
      this.state.storage,
      identity.data.ticketId,
      identity.data.ticketExpiresAt,
    )) {
      return jsonResponse({ error: "socket_ticket_replayed" }, 401);
    }

    const roomIdentity = RoomIdentitySchema.safeParse(await this.state.storage.get("roomIdentity"));
    if (
      roomIdentity.success &&
      (roomIdentity.data.workspaceId !== identity.data.workspaceId ||
        roomIdentity.data.workstreamId !== identity.data.workstreamId)
    ) {
      return jsonResponse({ error: "room_identity_mismatch" }, 409);
    }
    await this.state.storage.put("roomIdentity", {
      workspaceId: identity.data.workspaceId,
      workstreamId: identity.data.workstreamId
    });

    const pair = Object.values(new WebSocketPair());
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) return jsonResponse({ error: "websocket_unavailable" }, 500);

    const attachment: SocketAttachment = {
      connectionId: crypto.randomUUID(),
      workspaceId: identity.data.workspaceId,
      workstreamId: identity.data.workstreamId,
      userId: identity.data.userId,
      connectedAt: new Date().toISOString(),
      afterSequence: identity.data.afterSequence,
      subscribed: false
    };

    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server, [attachment.workspaceId, attachment.userId]);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptEvent(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const wrapped = BroadcastRequestSchema.safeParse(body);
    const unvalidatedEvent = wrapped.success ? wrapped.data.event : body;
    if (typeof unvalidatedEvent !== "object" || unvalidatedEvent === null) {
      return jsonResponse({ error: "invalid_event" }, 400);
    }

    const rawEvent = unvalidatedEvent as Record<string, unknown>;
    const requestedSequence =
      typeof rawEvent.sequence === "number" && Number.isSafeInteger(rawEvent.sequence)
        ? rawEvent.sequence
        : undefined;
    const sequence = await this.allocateSequence(requestedSequence);
    const candidate = {
      ...rawEvent,
      sequence,
      occurredAt:
        typeof rawEvent.occurredAt === "string" ? rawEvent.occurredAt : new Date().toISOString()
    };
    const event = ServerSocketEventSchema.safeParse(candidate);

    if (!event.success) {
      return jsonResponse(
        { error: "invalid_event", details: event.error.flatten().fieldErrors },
        400
      );
    }

    this.recordRecentEvent(event.data);
    this.broadcast(event.data);
    return jsonResponse({ accepted: true, sequence: event.data.sequence }, 202);
  }

  private async fulfillSubscription(
    socket: WebSocket,
    workspaceId: string,
    workstreamId: string,
    afterSequence: number,
  ): Promise<void> {
    let deliveredThrough = await this.currentSequence(workstreamId);
    await this.deliverReplayPlan(socket, workspaceId, workstreamId, deliveredThrough, planSocketReplay(
      afterSequence,
      deliveredThrough,
      this.replayFloorSequence,
      this.recentEvents,
    ));

    // Loading an initial snapshot awaits D1 and can yield to a concurrently
    // published event. Keep this socket out of broadcasts until a second,
    // in-memory catch-up closes that bootstrap race.
    const catchUpSequence = await this.currentSequence(workstreamId);
    if (catchUpSequence > deliveredThrough) {
      await this.deliverReplayPlan(
        socket,
        workspaceId,
        workstreamId,
        catchUpSequence,
        planSocketReplay(
          deliveredThrough,
          catchUpSequence,
          this.replayFloorSequence,
          this.recentEvents,
          false,
        ),
      );
      deliveredThrough = catchUpSequence;
    }

    const attachment = this.readAttachment(socket);
    if (!attachment) throw new Error("Missing connection identity during subscription");
    socket.serializeAttachment({
      ...attachment,
      afterSequence: deliveredThrough,
      subscribed: true,
    } satisfies SocketAttachment);
  }

  private async deliverReplayPlan(
    socket: WebSocket,
    workspaceId: string,
    workstreamId: string,
    currentSequence: number,
    plan: SocketReplayPlan,
  ): Promise<void> {
    if (plan.type === "snapshot") {
      await this.sendSnapshot(socket, workspaceId, workstreamId, currentSequence);
      return;
    }
    if (plan.type === "replay") {
      for (const event of plan.events) socket.send(JSON.stringify(event));
      return;
    }
    const event = ServerSocketEventSchema.parse({
      type: "resync_required",
      sequence: currentSequence,
      occurredAt: new Date().toISOString(),
      reason: plan.reason,
      latestSequence: currentSequence,
    });
    socket.send(JSON.stringify(event));
  }

  private async sendSnapshot(
    socket: WebSocket,
    workspaceId: string,
    workstreamId: string,
    knownSequence?: number,
  ): Promise<void> {
    try {
      const workstream = await this.loadSnapshot(workspaceId, workstreamId);
      const sequence = knownSequence ?? await this.currentSequence(workstreamId);
      const event = ServerSocketEventSchema.parse({
        type: "snapshot",
        sequence,
        occurredAt: new Date().toISOString(),
        workstream
      });
      socket.send(JSON.stringify(event));
    } catch {
      await this.sendError(socket, "snapshot_unavailable", "Canonical work-stream state is unavailable.");
    }
  }

  private async loadSnapshot(workspaceId: string, workstreamId: string): Promise<WorkstreamDetail> {
    const row = await this.env.DB.prepare(
      `SELECT * FROM workstreams WHERE id = ?1 AND workspace_id = ?2 LIMIT 1`
    )
      .bind(workstreamId, workspaceId)
      .first<WorkstreamRow>();
    if (!row) throw new Error("Work stream not found");

    const [participantRows, resourceRows, connectionRows, elicitationRows, suggestionRows, latestRun] =
      await Promise.all([
        this.env.DB.prepare(
          `SELECT u.*, wp.participation_reason, wp.joined_at
             FROM workstream_participants wp
             JOIN users u ON u.id = wp.user_id
            WHERE wp.workstream_id = ?1 AND wp.removed_at IS NULL
            ORDER BY wp.joined_at`
        )
          .bind(workstreamId)
          .all<UserRow & { participation_reason: string; joined_at: string }>(),
        this.env.DB.prepare(
          `SELECT r.*, CASE WHEN rw.id IS NOT NULL THEN 1 ELSE 0 END AS attached_watch_enabled
             FROM workstream_resources wr
             JOIN resources r ON r.id = wr.resource_id
             LEFT JOIN resource_watches rw
              ON rw.workstream_id = wr.workstream_id
              AND rw.resource_id = wr.resource_id
              AND rw.enabled = 1
            WHERE wr.workstream_id = ?1
            ORDER BY wr.attached_at`
        )
          .bind(workstreamId)
          .all<Record<string, unknown>>(),
        this.env.DB.prepare(
          `SELECT DISTINCT c.*, owner.name AS owner_name
             FROM workstream_resources wr
             JOIN resources r ON r.id = wr.resource_id
             JOIN connector_connections c ON c.id = r.connection_id
             LEFT JOIN users owner ON owner.id = c.owner_user_id
            WHERE wr.workstream_id = ?1
            ORDER BY c.created_at`
        )
          .bind(workstreamId)
          .all<Record<string, unknown>>(),
        this.env.DB.prepare(
          `SELECT * FROM elicitations
            WHERE workstream_id = ?1 AND status = 'open'
            ORDER BY created_at`
        )
          .bind(workstreamId)
          .all<Record<string, unknown>>(),
        this.env.DB.prepare(
          `SELECT s.*, a.title, a.summary
             FROM activity_suggestions s
             JOIN activities a ON a.id = s.activity_id
            WHERE s.workstream_id = ?1 AND s.status = 'pending'
            ORDER BY s.created_at DESC`
        )
          .bind(workstreamId)
          .all<Record<string, unknown>>(),
        this.env.DB.prepare(
          `SELECT id FROM harness_runs WHERE workstream_id = ?1 ORDER BY started_at DESC LIMIT 1`
        )
          .bind(workstreamId)
          .first<{ id: string }>()
      ]);

    const viewers = await this.loadViewers(workspaceId, workstreamId);

    return WorkstreamDetailSchema.parse({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      objective: row.objective,
      emailAddress: row.email_address,
      originType: row.origin_type,
      originLabel: null,
      createdByUserId: row.created_by_user_id,
      automationSubscriptionId: row.automation_subscription_id,
      automationRunId: row.automation_run_id,
      plannedFor: row.planned_for,
      harnessStatus: row.harness_status,
      lastActivityAt: row.last_activity_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      participants: participantRows.results.map((participant) => ({
        user: userFromRow(participant),
        participationReason: participant.participation_reason,
        joinedAt: participant.joined_at
      })),
      viewers,
      resources: resourceRows.results.map((resource) => ({
        id: resource.id,
        workspaceId: resource.workspace_id,
        connectionId: resource.connection_id,
        resourceType: resource.resource_type,
        provider: resource.provider,
        providerResourceId: resource.provider_resource_id,
        title: resource.title,
        mimeType: resource.mime_type,
        canonicalUrl: resource.canonical_url,
        watchEnabled: Number(resource.attached_watch_enabled) === 1,
        watchStatus: resource.connection_id == null
          ? "unsupported"
          : Number(resource.attached_watch_enabled) === 1 ? "watching" : "paused",
        lastHydratedAt: resource.last_hydrated_at,
        createdAt: resource.created_at,
        updatedAt: resource.updated_at
      })),
      connections: connectionRows.results.map((connection) => ({
        id: connection.id,
        workspaceId: connection.workspace_id,
        connectorType: connection.connector_type,
        scope: connection.scope,
        ownerUserId: connection.owner_user_id,
        ownerName: connection.owner_name ?? null,
        displayName: connection.display_name,
        grantedCapabilities: parseJsonArray(connection.granted_scopes_json),
        status: connection.status,
        lastSyncAt: connection.last_sync_at,
        createdAt: connection.created_at
      })),
      openElicitations: elicitationRows.results.map((elicitation) => ({
        id: elicitation.id,
        workstreamId: elicitation.workstream_id,
        harnessRunId: elicitation.harness_run_id,
        prompt: elicitation.prompt,
        responseType: elicitation.response_type,
        options: parseJsonArray(elicitation.options_json),
        minimumSelections: elicitation.minimum_selections ?? 0,
        maximumSelections: elicitation.maximum_selections ?? null,
        targetUserId: elicitation.target_user_id,
        status: elicitation.status,
        answer:
          typeof elicitation.answer_json === "string"
            ? (JSON.parse(elicitation.answer_json) as unknown)
            : null,
        answeredByUserId: elicitation.answered_by_user_id,
        createdAt: elicitation.created_at,
        answeredAt: elicitation.answered_at
      })),
      suggestions: suggestionRows.results.map((suggestion) => ({
        id: suggestion.id,
        activityId: suggestion.activity_id,
        workstreamId: suggestion.workstream_id,
        title: suggestion.title,
        summary: suggestion.summary,
        confidence: suggestion.confidence,
        reason: suggestion.reason,
        status: suggestion.status,
        createdAt: suggestion.created_at,
        resolvedAt: suggestion.resolved_at
      })),
      latestHarnessRunId: latestRun?.id ?? null
    });
  }

  private async loadViewers(
    workspaceId: string,
    workstreamId: string,
    excluding?: WebSocket
  ): Promise<WorkstreamDetail["viewers"]> {
    const attachments = this.state
      .getWebSockets()
      .filter((socket) => socket !== excluding)
      .map((socket) => this.readAttachment(socket))
      .filter((attachment): attachment is SocketAttachment =>
        Boolean(
          attachment
          && attachment.subscribed
          && attachment.workspaceId === workspaceId
          && attachment.workstreamId === workstreamId
        )
      );

    const participantRows = await this.env.DB.prepare(
      `SELECT user_id FROM workstream_participants
       WHERE workstream_id = ? AND removed_at IS NULL`,
    ).bind(workstreamId).all<{ user_id: string }>();
    const participantIds = new Set((participantRows.results ?? []).map((row) => row.user_id));
    const viewers = distinctNonParticipantViewers(attachments, participantIds);

    return Promise.all(
      viewers.map(async (attachment) => {
        const user = await this.env.DB.prepare(`SELECT * FROM users WHERE id = ?1 LIMIT 1`)
          .bind(attachment.userId)
          .first<UserRow>();
        if (!user) throw new Error("Viewer no longer exists");
        return { user: userFromRow(user), connectedAt: attachment.connectedAt };
      })
    );
  }

  private async broadcastPresence(
    workspaceId: string,
    workstreamId: string,
    excluding?: WebSocket,
  ): Promise<void> {
    try {
      const viewers = await this.loadViewers(workspaceId, workstreamId, excluding);
      const sequence = await this.allocateSequence();
      const event = ServerSocketEventSchema.parse({
        type: "presence_changed",
        sequence,
        occurredAt: new Date().toISOString(),
        viewers
      });
      this.recordRecentEvent(event);
      this.broadcast(event, excluding);
    } catch {
      // Presence is deliberately ephemeral. A failed presence refresh must not
      // break the canonical work-stream connection.
    }
  }

  private broadcast(event: ServerSocketEvent, excluding?: WebSocket): void {
    const payload = JSON.stringify(event);
    if (textEncoder.encode(payload).byteLength > 1_000_000) {
      throw new Error("Realtime event exceeds the bounded frame size");
    }

    for (const socket of this.state.getWebSockets()) {
      if (socket === excluding) continue;
      if (!this.readAttachment(socket)?.subscribed) continue;
      try {
        socket.send(payload);
      } catch {
        // The runtime will deliver close/error separately; one stale socket must
        // not prevent delivery to healthy clients.
      }
    }
  }

  private recordRecentEvent(event: ServerSocketEvent): void {
    if (event.type === "snapshot" || event.type === "error" || event.type === "resync_required") return;
    const bytes = textEncoder.encode(JSON.stringify(event)).byteLength;
    if (this.replayFloorSequence === null) this.replayFloorSequence = Math.max(0, event.sequence - 1);
    this.recentEvents.push(event);
    this.recentEventBytes += bytes;
    while (this.recentEvents.length > MAX_REPLAY_EVENTS || this.recentEventBytes > MAX_REPLAY_BYTES) {
      const removed = this.recentEvents.shift();
      if (!removed) break;
      this.recentEventBytes -= textEncoder.encode(JSON.stringify(removed)).byteLength;
      this.replayFloorSequence = removed.sequence;
    }
  }

  private async sendError(socket: WebSocket, code: string, message: string): Promise<void> {
    const event = ServerSocketEventSchema.parse({
      type: "error",
      sequence: await this.allocateSequence(),
      occurredAt: new Date().toISOString(),
      code,
      message
    });
    socket.send(JSON.stringify(event));
  }

  private readAttachment(socket: WebSocket): SocketAttachment | null {
    try {
      const parsed = SocketAttachmentSchema.safeParse(socket.deserializeAttachment());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async currentSequence(workstreamId: string): Promise<number> {
    const stored = (await this.state.storage.get<number>("eventSequence")) ?? 0;
    const canonical = await this.env.DB.prepare(
      `SELECT COALESCE(MAX(sequence_number), 0) AS sequence
         FROM messages
        WHERE workstream_id = ?1`
    )
      .bind(workstreamId)
      .first<{ sequence: number }>();
    if ((canonical?.sequence ?? 0) > stored) {
      await this.state.storage.put("eventSequence", canonical?.sequence ?? 0);
    }
    return Math.max(stored, canonical?.sequence ?? 0);
  }

  private async allocateSequence(requested?: number): Promise<number> {
    return this.state.storage.transaction(async (transaction) => {
      const current = (await transaction.get<number>("eventSequence")) ?? 0;
      const next = Math.max(current + 1, requested ?? 0);
      await transaction.put("eventSequence", next);
      return next;
    });
  }
}
