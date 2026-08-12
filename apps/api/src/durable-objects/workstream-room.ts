import {
  ActiveStreamCheckpointsSchema,
  ClientSocketEventSchema,
  IdSchema,
  PersonalSocketEventSchema,
  ServerSocketEventSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkstreamDetailSchema,
  type ActiveStreamCheckpoint,
  type PersonalSocketEvent,
  type ServerSocketEvent,
  type User,
  type WorkstreamDetail
} from "@avalon/contracts";
import { z } from "zod";

import type { Env } from "../env";
import { truncateUtf16Safe } from "../lib/text";
import { workstreamVisibilitySql } from "../lib/workstream-visibility";
import { connectionFromRow } from "../mappers/connection";
import {
  toWorkstream,
  WORKSTREAM_VIEWER_COLUMNS_SQL,
  WORKSTREAM_VIEWER_JOINS_SQL,
  workstreamViewerBindings,
} from "../mappers/workstream";
import { launchHyperSightRefresh } from "../services/hypersight-service";
import { memberSafeHarnessError } from "../services/workstream-service";

const SocketAttachmentSchema = z.object({
  connectionId: z.string().uuid(),
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  userId: IdSchema,
  connectedAt: z.string().datetime({ offset: true }),
  afterSequence: z.number().int().nonnegative(),
  subscribed: z.boolean().default(false)
});

const BroadcastRequestSchema = z.object({
  event: z.unknown(),
  audienceUserId: IdSchema.optional(),
}).strict();
const RoomIdentitySchema = z.object({ workspaceId: IdSchema, workstreamId: IdSchema });
const SOCKET_TICKET_PREFIX = "socket-ticket:";
const MAX_REPLAY_EVENTS = 256;
const MAX_REPLAY_BYTES = 512_000;
/**
 * How stale the room lets its picture of who may read this work stream get.
 *
 * The sweep is one indexed query over only the users currently connected, and
 * it is gated on an event actually being delivered, so a quiet room costs
 * nothing and a busy one pays it twice a minute. It is skipped for
 * `stream_delta`, which is the only high-frequency event and is always preceded
 * in the same turn by a `stream_started` that is not skipped.
 */
const AUTHORIZATION_REVALIDATE_MS = 30_000;
const HYPERSIGHT_DEBOUNCE_MS = 1_200;
const HYPERSIGHT_MAX_DEBOUNCE_MS = 5_000;
const HYPERSIGHT_REFRESH_EVENT_TYPES = new Set([
  "message_created",
  "stream_completed",
  "participant_added",
  "participant_removed",
  "resource_attached",
  "resource_updated",
  "elicitation_created",
  "elicitation_answered",
  "activity_suggestion_created",
  "activity_suggestion_resolved",
  "hypersight_configuration_updated",
]);
const ACTIVE_STREAM_CHECKPOINTS_KEY = "activeStreamCheckpoints";

type SocketAttachment = z.infer<typeof SocketAttachmentSchema>;

export function isPersonalEventAudience(socketUserId: string, audienceUserId: string): boolean {
  return socketUserId === audienceUserId;
}

interface PendingHyperSightRefresh {
  workspaceId: string;
  workstreamId: string;
  triggerSequence: number;
  firstQueuedAt: number;
}

/**
 * The snapshot's work-stream row, read through `toWorkstream` rather than
 * field by field. The viewer columns matter as much as the work stream's own:
 * `WorkstreamDetail` carries per-person read state, so a row selected without
 * the read-state join produces a snapshot that fails contract validation and
 * degrades every initial subscribe into a resync.
 */
type WorkstreamRow = Record<string, unknown>;

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  timezone: string;
  created_at: string;
}

const textEncoder = new TextEncoder();

/**
 * Whether this event can have taken somebody's read access away.
 *
 * A work stream becoming `personal` narrows it to its participants, and losing
 * a participant narrows it again — the second only matters while it is already
 * `personal`, but the sweep answers that itself rather than guessing here.
 */
function retractsReadAccess(event: ServerSocketEvent): boolean {
  if (event.type === "workstream_scope_changed") return event.scope === "personal";
  return event.type === "participant_removed";
}

/**
 * Fold one sequenced room event into the durable partial-response checkpoint.
 * This mirrors the renderer's Bind cursor rules so a fresh subscriber receives
 * exactly the text an uninterrupted subscriber is already displaying.
 */
export function applyActiveStreamCheckpointEvent(
  checkpoints: ActiveStreamCheckpoint[],
  event: ServerSocketEvent,
): ActiveStreamCheckpoint[] {
  if (event.type === "stream_completed") {
    return checkpoints.filter((checkpoint) => checkpoint.messageId !== event.message.id);
  }
  if (
    event.type === "harness_status_changed"
    && (event.status === "needs_input"
      || event.status === "completed"
      || event.status === "failed"
      || event.status === "idle")
  ) {
    return [];
  }
  if (event.type !== "stream_started" && event.type !== "stream_delta") return checkpoints;

  // Admission permits one active harness run per work stream. A start from a
  // different run supersedes a checkpoint whose terminal event never reached
  // the room, keeping this one accumulated value bounded across outages.
  const activeCheckpoints = event.type === "stream_started"
    ? checkpoints.filter((checkpoint) => checkpoint.harnessRunId === event.harnessRunId)
    : checkpoints;
  const existing = activeCheckpoints.find((checkpoint) => checkpoint.messageId === event.messageId);
  // The publisher always attempts `stream_started` first. If that room request
  // failed, a later delta cannot reconstruct the missing prefix and must not
  // manufacture a checkpoint that claims it can.
  if (event.type === "stream_delta" && !existing) return checkpoints;
  if (existing) {
    if (event.sequence <= existing.roomSequence) return checkpoints;
    if (event.turnId === existing.turnId) {
      if (event.epoch < existing.epoch) return checkpoints;
      if (event.epoch === existing.epoch && event.streamSeq <= existing.streamSeq) {
        return checkpoints;
      }
    } else if (existing.seenTurnIds.includes(event.turnId)) {
      return checkpoints;
    }
  }

  const startsNewTurn = !existing || event.turnId !== existing.turnId;
  const turnStartOffset = startsNewTurn ? existing?.text.length ?? 0 : existing.turnStartOffset;
  const replacesAttempt = event.reset
    || (existing !== undefined && !startsNewTurn && event.epoch > existing.epoch);
  const text = event.type === "stream_started"
    ? (replacesAttempt ? (existing?.text ?? "").slice(0, turnStartOffset) : existing?.text ?? "")
    : replacesAttempt
      ? `${(existing?.text ?? "").slice(0, turnStartOffset)}${event.delta}`
      : `${existing?.text ?? ""}${event.delta}`;
  const seenTurnIds = existing?.seenTurnIds.includes(event.turnId)
    ? existing.seenTurnIds
    : [...(existing?.seenTurnIds ?? []), event.turnId];
  const harnessRunId = event.type === "stream_started"
    ? event.harnessRunId
    : existing?.harnessRunId;
  if (!harnessRunId) return checkpoints;
  const next: ActiveStreamCheckpoint = {
    messageId: event.messageId,
    harnessRunId,
    turnId: event.turnId,
    epoch: event.epoch,
    streamSeq: event.streamSeq,
    seenTurnIds,
    text,
    turnStartOffset,
    roomSequence: event.sequence,
    createdAt: existing?.createdAt ?? event.occurredAt,
  };
  return [next];
}

/**
 * Take a socket out of the room and close it.
 *
 * The attachment is marked unsubscribed first, which is what {@link
 * WorkstreamRoom.broadcast} filters on. Closing alone would leave the guarantee
 * to the runtime — `send` on a closed socket throws, and that throw is caught —
 * so a disconnected reader would be spared the next frame by accident rather
 * than on purpose. On a privacy path that is the wrong place for the rule to
 * live.
 */
function disconnect(socket: WebSocket, code: number, reason: string): void {
  try {
    const attachment = SocketAttachmentSchema.safeParse(socket.deserializeAttachment());
    if (attachment.success) {
      socket.serializeAttachment({ ...attachment.data, subscribed: false } satisfies SocketAttachment);
    }
  } catch {
    // An unreadable attachment already fails the broadcast filter.
  }
  try {
    socket.close(code, reason);
  } catch {
    // Already gone; the runtime delivers the close separately.
  }
}

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
    timezone: row.timezone,
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

export async function loadVisibleWorkstreamRoomResources(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  viewerUserId: string,
): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(
    `SELECT r.*, CASE WHEN rw.id IS NOT NULL THEN 1 ELSE 0 END AS attached_watch_enabled
       FROM workstream_resources wr
       JOIN resources r ON r.id = wr.resource_id
       LEFT JOIN resource_watches rw
        ON rw.workstream_id = wr.workstream_id
        AND rw.resource_id = wr.resource_id
        AND rw.enabled = 1
      WHERE wr.workstream_id = ?1
        AND (r.provider != 'avalon_note' OR EXISTS (
          SELECT 1 FROM notes visible_note
          WHERE visible_note.resource_id = r.id
            AND visible_note.workspace_id = ?2
            AND visible_note.workspace_id = r.workspace_id
            AND visible_note.archived_at IS NULL
            AND (visible_note.scope = 'workspace' OR visible_note.owner_user_id = ?3)
        ))
      ORDER BY wr.attached_at`,
  ).bind(workstreamId, workspaceId, viewerUserId).all<Record<string, unknown>>();
  return result.results ?? [];
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
  /**
   * When the connected set was last checked against D1, in memory only. A
   * hibernated room wakes at zero and re-checks on its next event, which is the
   * conservative direction.
   */
  private lastRevalidatedAt = 0;

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

  async alarm(): Promise<void> {
    const pending = await this.state.storage.get<PendingHyperSightRefresh>("pendingHyperSightRefresh");
    if (!pending) return;
    await this.state.storage.delete("pendingHyperSightRefresh");
    try {
      const runs = await launchHyperSightRefresh(
        this.env,
        pending.workspaceId,
        pending.workstreamId,
        pending.triggerSequence,
      );
      for (const run of runs) {
        const event = ServerSocketEventSchema.parse({
          type: "hypersight_block_run_updated",
          sequence: await this.allocateSequence(),
          occurredAt: new Date().toISOString(),
          run,
        });
        this.recordRecentEvent(event);
        this.broadcast(event);
      }
    } catch {
      await this.state.storage.put("pendingHyperSightRefresh", pending);
      await this.state.storage.setAlarm(Date.now() + HYPERSIGHT_DEBOUNCE_MS);
    }
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

    // The same rule the REST reads enforce, not a copy of it. This authorizer
    // was a copy, and it had drifted: it checked the automation clause and not
    // `scope`, so a member who was not a participant could open a socket onto a
    // private work stream and be sent its transcript.
    const authorized = await this.env.DB.prepare(
      `SELECT 1
         FROM workstreams w
         JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
        WHERE w.id = ?1
          AND w.workspace_id = ?2
          AND wm.user_id = ?3
          AND wm.status = 'active'
          AND w.archived_at IS NULL
          AND ${workstreamVisibilitySql("?3")}
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

    const requestIdentity = RoomIdentitySchema.safeParse({
      workspaceId: request.headers.get("x-avalon-workspace-id"),
      workstreamId: request.headers.get("x-avalon-workstream-id"),
    });
    if (requestIdentity.success) {
      const storedIdentity = RoomIdentitySchema.safeParse(await this.state.storage.get("roomIdentity"));
      if (!storedIdentity.success) {
        await this.state.storage.put("roomIdentity", requestIdentity.data);
      } else if (
        storedIdentity.data.workspaceId !== requestIdentity.data.workspaceId
        || storedIdentity.data.workstreamId !== requestIdentity.data.workstreamId
      ) {
        return jsonResponse({ error: "room_identity_mismatch" }, 409);
      }
    }

    const rawEvent = unvalidatedEvent as Record<string, unknown>;
    if (wrapped.success && wrapped.data.audienceUserId) {
      const personalEvent = PersonalSocketEventSchema.safeParse({
        ...rawEvent,
        occurredAt:
          typeof rawEvent.occurredAt === "string" ? rawEvent.occurredAt : new Date().toISOString(),
      });
      if (!personalEvent.success) {
        return jsonResponse(
          { error: "invalid_event", details: personalEvent.error.flatten().fieldErrors },
          400,
        );
      }
      this.broadcast(personalEvent.data, undefined, wrapped.data.audienceUserId);
      return jsonResponse({ accepted: true }, 202);
    }

    const requestedSequence =
      typeof rawEvent.sequence === "number" && Number.isSafeInteger(rawEvent.sequence)
        ? rawEvent.sequence
        : undefined;
    const candidate = {
      ...rawEvent,
      // Validate before consuming a room sequence. The committed event is
      // assigned its real sequence atomically with any stream checkpoint.
      sequence: 0,
      occurredAt:
        typeof rawEvent.occurredAt === "string" ? rawEvent.occurredAt : new Date().toISOString()
    };
    const unsequencedEvent = ServerSocketEventSchema.safeParse(candidate);

    if (!unsequencedEvent.success) {
      return jsonResponse(
        { error: "invalid_event", details: unsequencedEvent.error.flatten().fieldErrors },
        400
      );
    }
    const event = await this.commitRealtimeEvent(unsequencedEvent.data, requestedSequence);

    this.recordRecentEvent(event);
    // Authorization is decided once, when each socket connects, so anything that
    // can retract it has to reach the connections already inside the room.
    // Sweeping before the broadcast means the people this event excluded do not
    // receive it — they are disconnected instead, and their client stops rather
    // than resynchronizing into a work stream it may no longer read.
    let evicted = false;
    if (retractsReadAccess(event)) {
      evicted = await this.evictReadersWhoMayNoLongerRead(true);
    } else if (
      // The publisher that delivers the event above swallows its own failures,
      // because for every other event realtime is an optimization. For a
      // retraction it is enforcement, so the room does not rely on having been
      // told: it re-asks the question on its own, at most once an interval, and
      // a retraction that never arrived is applied before the next thing this
      // room would have sent. That also covers the retractions nothing
      // publishes at all, such as a workspace membership going inactive.
      event.type !== "stream_delta"
      && Date.now() - this.lastRevalidatedAt >= AUTHORIZATION_REVALIDATE_MS
    ) {
      evicted = await this.evictReadersWhoMayNoLongerRead(false);
    }
    this.broadcast(event);
    // After the event, not inside the sweep. Presence allocates a sequence of
    // its own, and this event's was allocated before the sweep ran — sending
    // the roster first would put a higher sequence on the wire ahead of a lower
    // one, and the client drops anything at or below the last sequence it
    // applied. The event that closed the work stream would be the one thrown
    // away. Every other close in this class refreshes the roster too, and this
    // one must: `webSocketClose` fires for a *client*-initiated close, so
    // closing a socket here invokes nothing, and the people who remain would go
    // on seeing the evicted readers listed as present. `disconnect` has already
    // marked those attachments unsubscribed, which is the filter `loadViewers`
    // applies, so they drop out without an exclusion argument.
    if (evicted) {
      const identity = RoomIdentitySchema.safeParse(await this.state.storage.get("roomIdentity"));
      if (identity.success) {
        await this.broadcastPresence(identity.data.workspaceId, identity.data.workstreamId);
      }
    }
    if (HYPERSIGHT_REFRESH_EVENT_TYPES.has(event.type)) {
      await this.scheduleHyperSightRefresh(event.sequence);
    }
    return jsonResponse({ accepted: true, sequence: event.sequence }, 202);
  }

  /**
   * Disconnect every socket whose user may no longer read this work stream.
   *
   * A socket is authorized once, when it connects, and then lives for as long
   * as the window stays open. Narrowing a work stream to its participants, or
   * taking somebody out of a narrowed one, has to reach the connections already
   * inside it, or the change would apply to everyone who opens it next and to
   * nobody who is reading it now.
   *
   * The question is asked of the whole connected set in one query rather than
   * per socket, and it is the same rule the connection itself was checked
   * against.
   *
   * `certain` says whether this sweep is resolving a retraction that just
   * happened, and it decides only what to do when the query itself fails —
   * which is the one case where the room does not know who may stay. See
   * {@link evictEveryReaderPendingReauthorization}.
   */
  private async evictReadersWhoMayNoLongerRead(certain: boolean): Promise<boolean> {
    const sockets = this.state.getWebSockets();
    const byUserId = new Map<string, WebSocket[]>();
    for (const socket of sockets) {
      const attachment = this.readAttachment(socket);
      if (!attachment) continue;
      const existing = byUserId.get(attachment.userId);
      if (existing) existing.push(socket);
      else byUserId.set(attachment.userId, [socket]);
    }
    if (byUserId.size === 0) return false;

    const identity = RoomIdentitySchema.safeParse(await this.state.storage.get("roomIdentity"));
    if (!identity.success) return false;
    const userIds = [...byUserId.keys()];
    const placeholders = userIds.map(() => "?").join(",");
    let permitted: Set<string>;
    try {
      const result = await this.env.DB.prepare(
        `SELECT wm.user_id
           FROM workspace_members wm
           JOIN workstreams w ON w.id = ? AND w.workspace_id = ?
          WHERE wm.workspace_id = w.workspace_id
            AND wm.status = 'active'
            AND wm.user_id IN (${placeholders})
            AND ${workstreamVisibilitySql("wm.user_id")}`
      )
        .bind(identity.data.workstreamId, identity.data.workspaceId, ...userIds)
        .all<{ user_id: string }>();
      permitted = new Set((result.results ?? []).map((row) => row.user_id));
    } catch {
      if (certain) {
        this.evictEveryReaderPendingReauthorization(sockets);
        // Either way the sweep is not recorded as having run, so the next event
        // re-asks rather than waiting out the interval.
        return true;
      }
      return false;
    }
    this.lastRevalidatedAt = Date.now();

    let evicted = false;
    for (const [userId, userSockets] of byUserId) {
      if (permitted.has(userId)) continue;
      for (const socket of userSockets) {
        disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
        evicted = true;
      }
    }
    return evicted;
  }

  /**
   * The answer when a retraction has definitely happened and the room cannot
   * find out who it applies to.
   *
   * Leaving every socket open would keep serving the work stream to the people
   * it was just closed to, so the room disconnects all of them — but as `1011`,
   * a transient server condition, not as the access-revoked code. That
   * distinction is the whole point: a reconnect is authorized against D1 at
   * connect time, so everyone who may still read it is back within a second,
   * and only those who genuinely lost access fail to return. Closing them all
   * as "access revoked" would instead strand every legitimate reader on an
   * error screen over what may have been one failed query.
   */
  private evictEveryReaderPendingReauthorization(sockets: WebSocket[]): void {
    for (const socket of sockets) disconnect(socket, 1011, "Reconnect to continue reading this work stream");
  }

  private async scheduleHyperSightRefresh(triggerSequence: number): Promise<void> {
    const identity = RoomIdentitySchema.safeParse(await this.state.storage.get("roomIdentity"));
    if (!identity.success) return;
    const now = Date.now();
    const existing = await this.state.storage.get<PendingHyperSightRefresh>("pendingHyperSightRefresh");
    const pending: PendingHyperSightRefresh = {
      ...identity.data,
      triggerSequence: Math.max(existing?.triggerSequence ?? 0, triggerSequence),
      firstQueuedAt: existing?.firstQueuedAt ?? now,
    };
    await this.state.storage.put("pendingHyperSightRefresh", pending);
    await this.state.storage.setAlarm(Math.min(
      now + HYPERSIGHT_DEBOUNCE_MS,
      pending.firstQueuedAt + HYPERSIGHT_MAX_DEBOUNCE_MS,
    ));
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
      activeStreams: plan.reason === "history_unavailable"
        ? ActiveStreamCheckpointsSchema.catch([]).parse(
            await this.state.storage.get(ACTIVE_STREAM_CHECKPOINTS_KEY),
          )
        : [],
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
      const attachment = this.readAttachment(socket);
      if (!attachment) throw new Error("Missing connection identity while loading snapshot");
      const workstream = await this.loadSnapshot(workspaceId, workstreamId, attachment.userId);
      const sequence = knownSequence ?? await this.currentSequence(workstreamId);
      const storedCheckpoints = ActiveStreamCheckpointsSchema.safeParse(
        await this.state.storage.get(ACTIVE_STREAM_CHECKPOINTS_KEY),
      );
      const event = ServerSocketEventSchema.parse({
        type: "snapshot",
        sequence,
        occurredAt: new Date().toISOString(),
        workstream,
        activeStreams: workstream.harnessStatus === "running" && storedCheckpoints.success
          ? storedCheckpoints.data.filter((checkpoint) =>
              checkpoint.harnessRunId === workstream.latestHarnessRunId)
          : [],
      });
      socket.send(JSON.stringify(event));
    } catch {
      await this.sendError(socket, "snapshot_unavailable", "Canonical work-stream state is unavailable.");
    }
  }

  private async loadSnapshot(
    workspaceId: string,
    workstreamId: string,
    viewerUserId: string,
  ): Promise<WorkstreamDetail> {
    return loadWorkstreamRoomSnapshot(this.env, {
      workspaceId,
      workstreamId,
      viewerUserId,
      viewers: await this.loadViewers(workspaceId, workstreamId),
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

  private broadcast(
    event: ServerSocketEvent | PersonalSocketEvent,
    excluding?: WebSocket,
    audienceUserId?: string,
  ): void {
    const payload = JSON.stringify(event);
    if (textEncoder.encode(payload).byteLength > 1_000_000) {
      throw new Error("Realtime event exceeds the bounded frame size");
    }

    for (const socket of this.state.getWebSockets()) {
      if (socket === excluding) continue;
      const attachment = this.readAttachment(socket);
      if (!attachment?.subscribed) continue;
      if (audienceUserId && !isPersonalEventAudience(attachment.userId, audienceUserId)) continue;
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

  /**
   * The event sequence and accumulated active text are one durable commit. A
   * snapshot can therefore be older than a concurrently arriving event (the
   * subscription catch-up handles that), but can never skip a stream frame
   * whose sequence it already claims to include.
   */
  private async commitRealtimeEvent(
    unsequencedEvent: ServerSocketEvent,
    requestedSequence?: number,
  ): Promise<ServerSocketEvent> {
    return this.state.storage.transaction(async (transaction) => {
      const current = (await transaction.get<number>("eventSequence")) ?? 0;
      const sequence = Math.max(current + 1, requestedSequence ?? 0);
      const event = ServerSocketEventSchema.parse({ ...unsequencedEvent, sequence });
      const storedValue = await transaction.get(ACTIVE_STREAM_CHECKPOINTS_KEY);
      const stored = ActiveStreamCheckpointsSchema.safeParse(storedValue);
      const checkpoints = stored.success ? stored.data : [];
      const nextCheckpoints = applyActiveStreamCheckpointEvent(checkpoints, event);

      await transaction.put("eventSequence", sequence);
      if (nextCheckpoints.length > 0 && nextCheckpoints !== checkpoints) {
        await transaction.put(ACTIVE_STREAM_CHECKPOINTS_KEY, nextCheckpoints);
      } else if (
        nextCheckpoints.length === 0
        && storedValue !== undefined
        && (nextCheckpoints !== checkpoints || !stored.success)
      ) {
        await transaction.delete(ACTIVE_STREAM_CHECKPOINTS_KEY);
      }
      return event;
    });
  }
}

/**
 * The canonical work stream one subscriber is sent on connecting.
 *
 * Exported so the shape it produces can be asserted against the contract
 * directly: a snapshot that fails validation is not an error anyone sees — the
 * room answers `snapshot_unavailable`, the client resynchronizes over REST, and
 * every live update between the two is simply missed.
 */
export async function loadWorkstreamRoomSnapshot(
  env: Env,
  input: {
    workspaceId: string;
    workstreamId: string;
    viewerUserId: string;
    viewers: WorkstreamDetail["viewers"];
  },
): Promise<WorkstreamDetail> {
  const { workspaceId, workstreamId, viewerUserId, viewers } = input;
  const row = await env.DB.prepare(
    `SELECT w.*, ${WORKSTREAM_VIEWER_COLUMNS_SQL}
       FROM workstreams w
       ${WORKSTREAM_VIEWER_JOINS_SQL}
      WHERE w.id = ? AND w.workspace_id = ? LIMIT 1`
  )
    .bind(...workstreamViewerBindings(viewerUserId), workstreamId, workspaceId)
    .first<WorkstreamRow>();
  if (!row) throw new Error("Work stream not found");

  const [participantRows, resourceRows, connectionRows, elicitationRows, suggestionRows, latestRun] =
    await Promise.all([
      env.DB.prepare(
        `SELECT u.*, wp.participation_reason, wp.joined_at
           FROM workstream_participants wp
           JOIN users u ON u.id = wp.user_id
          WHERE wp.workstream_id = ?1 AND wp.removed_at IS NULL
          ORDER BY wp.joined_at`
      )
        .bind(workstreamId)
        .all<UserRow & { participation_reason: string; joined_at: string }>(),
      loadVisibleWorkstreamRoomResources(env, workspaceId, workstreamId, viewerUserId),
      env.DB.prepare(
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
      env.DB.prepare(
        `SELECT * FROM elicitations
          WHERE workstream_id = ?1 AND status = 'open'
          ORDER BY created_at`
      )
        .bind(workstreamId)
        .all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT s.*, a.title, a.summary
           FROM activity_suggestions s
           JOIN activities a ON a.id = s.activity_id
          WHERE s.workstream_id = ?1 AND s.status = 'pending'
          ORDER BY s.created_at DESC`
      )
        .bind(workstreamId)
        .all<Record<string, unknown>>(),
      // The same columns and the same order as `GET /workstreams/:id`. A
      // snapshot replaces the client's whole detail, so anything it omits is
      // lost until the next REST read — omitting the run itself left a running
      // work stream with no work timer for the life of the run — and anything
      // it answers differently overwrites the right answer with a wrong one.
      // `created_at` rather than `started_at` for exactly that reason: a
      // `scheduled` run is inserted with `started_at` NULL, SQLite sorts NULLs
      // last under DESC, and this would otherwise hand the client an older run.
      env.DB.prepare(
        `SELECT id, origin, status, model, error_json, started_at, completed_at, created_at
           FROM harness_runs
          WHERE workstream_id = ?1 AND parent_tool_call_id IS NULL
            AND origin != 'hypersight_block'
          ORDER BY created_at DESC LIMIT 1`
      )
        .bind(workstreamId)
        .first<Record<string, unknown>>()
    ]);

  return WorkstreamDetailSchema.parse({
    ...toWorkstream(row),
    participants: participantRows.results.map((participant) => ({
      user: userFromRow(participant),
      participationReason: participant.participation_reason,
      joinedAt: participant.joined_at
    })),
    viewers,
    resources: resourceRows.map((resource) => ({
      id: resource.id,
      workspaceId: resource.workspace_id,
      connectionId: resource.connection_id,
      resourceType: resource.resource_type,
      provider: resource.provider,
      providerResourceId: resource.provider_resource_id,
      title: truncateUtf16Safe(String(resource.title), 300),
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
    connections: connectionRows.results.map((row) => connectionFromRow(row)),
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
      title: truncateUtf16Safe(String(suggestion.title), 300),
      summary: truncateUtf16Safe(String(suggestion.summary), 2_000),
      confidence: suggestion.confidence,
      reason: truncateUtf16Safe(String(suggestion.reason), 1_200),
      status: suggestion.status,
      createdAt: suggestion.created_at,
      resolvedAt: suggestion.resolved_at
    })),
    latestHarnessRunId: latestRun?.id == null ? null : String(latestRun.id),
    latestHarnessRun: latestRun ? {
      id: String(latestRun.id),
      origin: String(latestRun.origin),
      status: String(latestRun.status),
      model: latestRun.model == null ? null : String(latestRun.model),
      error: memberSafeHarnessError(latestRun.error_json),
      requestId: String(latestRun.id),
      startedAt: latestRun.started_at == null ? null : String(latestRun.started_at),
      completedAt: latestRun.completed_at == null ? null : String(latestRun.completed_at),
      createdAt: String(latestRun.created_at)
    } : null
  });
}
