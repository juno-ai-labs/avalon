import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import {
  MESSAGE_TOO_LONG_MESSAGE,
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSPACE_SYNC_TOPICS,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceProjectSnapshotEventSchema,
  WorkspaceSidebarListEventSchema,
  WorkspaceSidebarSchema,
  WorkspaceWorkstreamPageEventSchema,
  WorkspaceWorkstreamStateEventSchema,
  WorkspaceSocketClientEventSchema,
  WorkspacePresenceEventSchema,
  WorkspaceSocketSyncEventSchema,
  WorkspaceSyncTopicSchema,
  WorkstreamSocketCommandResultSchema,
  type WorkspaceSidebar,
  type NoteSummary,
  type ProjectSnapshot,
  type WorkspaceSocketSyncEvent,
  type WorkspaceSyncTopic,
} from "@rally/contracts";
import { z } from "zod";

import type { AuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import {
  isWorkspacePlacementAffinityForRegion,
} from "../lib/durable-object-namespace";
import { WorkspaceDoCore } from "./workspace-do-core";
import { uuidV7 } from "../lib/uuid-v7";
import { logWarn } from "../observability/logger";
import { identityAttributes, inFlowSpan } from "../observability/tracing";
import {
  acceptsNewWorkstreamWork,
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import { resolveClientFeatureFlagsForSubject } from "../services/client-feature-flags";
import {
  revocationClosesSocket,
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";
import { SIDEBAR_LIST_LIMIT } from "../services/sidebar-reads";
import {
  type SidebarList,
} from "./workspace-runtime-sql-guards";
import {
  SocketIdentitySchema,
  closeWorkspaceSocket,
  contributesPresence,
  disconnect,
  overLongCreateMessageCommand,
  readAttachment,
  type CreateMessageCommand,
  type SocketIdentity,
  type WorkspaceSocketAttachment,
  type WorkspaceSocketCloseInput,
} from "./workspace-socket-session";
import {
  SELECT_WORKSPACE_DIRECTORY,
  directoryStateVersion,
  directoryWorkstream,
  listWorkspaceDirectory,
  loadParticipantPreviews,
  workspaceDirectoryVisible,
  type WorkspaceDirectoryRow,
} from "./workspace-directory-storage";
import {
  listSidebarAutomations,
} from "./workspace-automation-directory-storage";
import {
  workspaceNoteSidebar,
} from "./workspace-notes-storage";
import {
  json,
} from "./rpc-result";

/**
 * What the command socket's authorization query answers with. The analytics
 * column is absent on the development path, which selects only the role —
 * optional rather than nullable so that shape stays legal.
 */
interface WorkspaceAuthRoleRow {
  role: AuthContext["role"];
  analytics_workspace_id?: string | null;
}

/**
 * `WorkspaceDO`'s hibernating command socket: acceptance, the client frame
 * handler, presence, and every push that goes back out over it.
 *
 * One link of the `WorkspaceDO` chain; `workspace-do-core.ts` explains it.
 */
export abstract class WorkspaceDoSockets extends WorkspaceDoCore {

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
      this.closeSocket(socket, null, {
        code: 1011,
        reason: "Missing workspace connection identity",
        cause: "missing_connection_identity",
        operation: "attachment",
      });
      return;
    }
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const frameBytes = typeof message === "string"
      ? new TextEncoder().encode(message).byteLength
      : message.byteLength;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.closeSocket(socket, attachment, {
        code: WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
        reason: "Workspace commands must be JSON",
        cause: "invalid_json",
        operation: "decode",
        frameBytes,
        validationIssues: [{ path: "(root)", code: "invalid_json" }],
      });
      return;
    }
    // Ahead of the parse, and the only bound that is. Every other way this
    // event can be malformed is a client defect, and closing the socket is the
    // right answer to one. An over-long message is not a defect — it is a
    // person who pasted more than Avalon takes — and closing their connection
    // to say so would drop the transcript they are looking at, tell them
    // nothing, and reconnect into the same refusal on the next attempt. The
    // desktop already stops this at the composer; this is what a build that has
    // not caught up, or a message grown past the ceiling between the two, is
    // told instead.
    const overLong = overLongCreateMessageCommand(decoded);
    if (overLong) {
      socket.send(JSON.stringify(WorkstreamSocketCommandResultSchema.parse({
        type: "client_command_failed",
        command: "create_message",
        clientMessageId: overLong.clientMessageId,
        error: { status: 400, code: "message_too_long", message: MESSAGE_TOO_LONG_MESSAGE },
      })));
      return;
    }
    const parsed = WorkspaceSocketClientEventSchema.safeParse(decoded);
    if (!parsed.success) {
      this.closeSocket(socket, attachment, {
        code: WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
        reason: "Invalid workspace socket event",
        cause: "invalid_event",
        operation: "validate",
        frameBytes,
        validationIssues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join(".") || "(root)",
          code: issue.code,
        })),
      });
      return;
    }
    if (parsed.data.type === "subscribe") {
      const auth = await this.sessionAuth(attachment);
      if (!auth) {
        this.closeSocket(socket, attachment, {
          code: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
          reason: "Session no longer active",
          cause: "session_inactive",
          operation: "subscribe",
        });
        return;
      }
      await this.subscribe(socket, attachment, parsed.data.afterWaterline);
      return;
    }
    if (parsed.data.type === "set_presence") {
      const auth = await this.sessionAuth(attachment);
      if (!auth) {
        this.closeSocket(socket, attachment, {
          code: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
          reason: "Session no longer active",
          cause: "session_inactive",
          operation: "presence",
        });
        return;
      }
      // D1 authentication yields the input gate. A newer focus transition can
      // therefore finish while this one is waiting; re-read the attachment and
      // fence the older command before it can restore stale presence.
      const currentAttachment = readAttachment(socket);
      if (!currentAttachment || parsed.data.revision <= currentAttachment.presenceRevision) return;
      if (!currentAttachment.subscribed
        || (parsed.data.foregroundWorkstreamId !== null
          && !workspaceDirectoryVisible(this.state.storage, currentAttachment.userId, parsed.data.foregroundWorkstreamId))) {
        this.closeSocket(socket, currentAttachment, {
          code: WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
          reason: "Invalid workspace presence",
          cause: currentAttachment.subscribed
            ? "presence_workstream_inaccessible"
            : "presence_before_subscribe",
          operation: "presence",
        });
        return;
      }
      const presenceChanged = currentAttachment.applicationState !== parsed.data.applicationState
        || currentAttachment.foregroundWorkstreamId !== parsed.data.foregroundWorkstreamId;
      socket.serializeAttachment({
        ...currentAttachment,
        presenceRevision: parsed.data.revision,
        applicationState: parsed.data.applicationState,
        foregroundWorkstreamId: parsed.data.foregroundWorkstreamId,
      } satisfies WorkspaceSocketAttachment);
      if (presenceChanged) this.broadcastPresence();
      return;
    }
    if (parsed.data.type === "list_workstreams") {
      const auth = await this.sessionAuth(attachment);
      if (!auth) {
        this.closeSocket(socket, attachment, {
          code: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
          reason: "Session no longer active",
          cause: "session_inactive",
          operation: "list_workstreams",
        });
        return;
      }
      const page = listWorkspaceDirectory(this.state.storage, {
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

  override webSocketClose(socket: WebSocket): void {
    if (contributesPresence(readAttachment(socket))) this.broadcastPresence(socket);
  }

  override webSocketError(socket: WebSocket): void {
    // The client reconnects with a new one-time ticket when it still has work;
    // everyone else must stop seeing the failed connection immediately.
    if (contributesPresence(readAttachment(socket))) this.broadcastPresence(socket);
  }

  private closeSocket(
    socket: WebSocket,
    attachment: WorkspaceSocketAttachment | null,
    input: WorkspaceSocketCloseInput,
  ): void {
    const wasPresent = contributesPresence(attachment);
    if (wasPresent) {
      try {
        socket.serializeAttachment({
          ...attachment,
          applicationState: "background",
          foregroundWorkstreamId: null,
        } satisfies WorkspaceSocketAttachment);
      } catch {
        // Closing and the exclusion fence below still remove this socket from
        // the canonical set when its attachment cannot be rewritten.
      }
    }
    closeWorkspaceSocket(this.env, socket, attachment, input);
    // Exclusion is the cleanup fence even if attachment serialization failed
    // while disconnecting. A broken socket cannot block or rejoin this rebuild.
    if (wasPresent) this.broadcastPresence(socket);
  }

  /**
   * Send each connection only the presence for the work stream it currently
   * foregrounds. This both avoids leaking personal work-stream identities and
   * keeps the frame equal to the one face pile the renderer can paint.
   */
  protected broadcastPresence(excluding?: WebSocket): void {
    const sockets: Array<{ socket: WebSocket; attachment: WorkspaceSocketAttachment }> = [];
    for (const socket of this.state.getWebSockets()) {
      if (socket === excluding) continue;
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      if (contributesPresence(attachment)
        && !workspaceDirectoryVisible(this.state.storage, attachment.userId, attachment.foregroundWorkstreamId)) {
        try {
          socket.serializeAttachment({
            ...attachment,
            applicationState: "background",
            foregroundWorkstreamId: null,
          } satisfies WorkspaceSocketAttachment);
        } catch {
          // Fail closed: an attachment that cannot record lost visibility must
          // reconnect before it can contribute or receive presence again.
          disconnect(socket, WORKSPACE_SOCKET_INVALID_MESSAGE_CODE, "Invalid workspace presence");
        }
        continue;
      }
      sockets.push({ socket, attachment });
    }
    const presentUsers = new Map<string, Set<string>>();
    for (const { attachment } of sockets) {
      if (attachment.applicationState !== "foreground" || attachment.foregroundWorkstreamId === null) continue;
      const users = presentUsers.get(attachment.foregroundWorkstreamId) ?? new Set<string>();
      users.add(attachment.userId);
      presentUsers.set(attachment.foregroundWorkstreamId, users);
    }
    const occurredAt = new Date().toISOString();
    for (const { socket, attachment } of sockets) {
      if (!contributesPresence(attachment)) continue;
      const workstreamId = attachment.foregroundWorkstreamId;
      const userIds = [...(presentUsers.get(workstreamId) ?? [])]
        .filter((userId) => userId !== attachment.userId);
      try {
        socket.send(JSON.stringify(WorkspacePresenceEventSchema.parse({
          type: "workspace_presence",
          occurredAt,
          workstreamId,
          userIds,
        })));
      } catch {
        // Presence is reconstructed from healthy attachments on the next
        // foreground change. One stale socket must not block the others.
      }
    }
  }

  /**
   * Drop every socket this object holds for a person whose access ended, and
   * carry the same revocation to the work streams they could be reading.
   *
   * The only way a socket here is closed for lost access. Nothing in this
   * object can observe a revoked session or an ended membership — both are D1
   * facts owned by the Worker that wrote them — so it is told, once, by the
   * access-revocation consumer. See `docs/access-revocation.md`.
   *
   * The work streams come back as a list rather than being published from
   * here: this object holds sockets and a directory, and that is all it needs
   * to know. The consumer decides what to do with the list, so nothing about
   * the revocation transport reaches inside the object.
   */
  async revokeSocketAccess(revocation: SocketAccessRevocation): Promise<{
    workstreamIds: string[];
    automationIds: string[];
  }> {
    await this.initialized;
    const request = SocketAccessRevocationSchema.parse(revocation);
    let closed = 0;
    let presenceChanged = false;
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      // A revoked session closes only the windows that presented it; an ended
      // membership carries no session and closes all of them. The rule lives in
      // one place because the four socket roles disagree about their own
      // attachments — see `revocationClosesSocket`.
      if (!attachment || !revocationClosesSocket(request, attachment)) continue;
      const wasPresent = contributesPresence(attachment);
      presenceChanged ||= wasPresent;
      if (wasPresent) {
        try {
          socket.serializeAttachment({
            ...attachment,
            applicationState: "background",
            foregroundWorkstreamId: null,
          } satisfies WorkspaceSocketAttachment);
        } catch {
          // `disconnect` still unsubscribes or closes the socket; a failed
          // attachment rewrite must not interrupt access revocation.
        }
      }
      disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer access this workspace");
      closed += 1;
    }
    if (closed > 0) {
      if (presenceChanged) this.broadcastPresence();
      logWarn(this.env, "workspace_socket_access_revoked", {
        workspace_id: this.workspaceId(),
        user_id: request.userId,
        session_id: request.sessionId,
        sockets: closed,
      });
    }
    return {
      workstreamIds: this.revocableWorkstreamIds(request.userId),
      // Only the author can hold an automation socket, so a revocation reaches
      // exactly the automations they authored; a membership-wide revocation
      // carries no user and reaches all of them.
      automationIds: this.state.storage.sql.exec<{ automation_id: string }>(
        request.userId
          ? `SELECT automation_id FROM automation_directory
              WHERE lifecycle <> 'deleted' AND author_user_id = ? ORDER BY automation_id`
          : `SELECT automation_id FROM automation_directory
              WHERE lifecycle <> 'deleted' ORDER BY automation_id`,
        ...(request.userId ? [request.userId] : []),
      ).toArray().map((row) => row.automation_id),
    };
  }

  /**
   * The work streams this person could be holding a socket on.
   *
   * Their own rows, plus every workspace-scoped work stream — those are
   * readable by any member, so a socket can exist there without this object
   * ever having written a viewer row for them. Narrower than the directory and
   * still complete; a personal work stream they never joined cannot have
   * admitted them in the first place.
   */
  private revocableWorkstreamIds(userId: string): string[] {
    return this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id
         FROM workspace_workstream_directory directory
         LEFT JOIN workspace_workstream_viewers viewer
           ON viewer.workstream_id = directory.workstream_id AND viewer.user_id = ?
        WHERE viewer.user_id IS NOT NULL OR directory.scope = 'workspace'
        ORDER BY directory.workstream_id`,
      userId,
    ).toArray().map((row) => row.workstream_id);
  }

  private async acceptSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }
    const identity = SocketIdentitySchema.safeParse({
      workspaceId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSPACE_ID) ?? null,
      userId: readRallyHeader(request.headers, RALLY_HEADERS.USER_ID) ?? null,
      sessionId: readRallyHeader(request.headers, RALLY_HEADERS.SESSION_ID) ?? null,
      ticketId: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_ID) ?? null,
      ticketExpiresAt: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_EXPIRES_AT) ?? null,
    });
    if (!identity.success) return json({ error: "invalid_socket_identity" }, 400);

    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority) || authority.phase !== "durable_object_open") {
      return json({ error: "workstream_maintenance", phase: authority.phase }, 503);
    }
    const placementAffinity = readRallyHeader(request.headers, RALLY_HEADERS.PLACEMENT_AFFINITY) ?? null;
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
      presenceRevision: 0,
      applicationState: "background",
      foregroundWorkstreamId: null,
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
    // A command arrives over an already-open socket, which the platform traces
    // as its own invocation with no relationship to the HTTP request the
    // desktop made to open it. `rally.message.client_id` is what joins this
    // trace to the composer that sent it: the desktop prints the same id, and
    // the command result comes back keyed by it.
    return inFlowSpan(this.env, "workstream.message.send", {
      flow: "workstream_message_send",
      component: "workspace_do",
      identity: {
        workspaceId: attachment.workspaceId,
        workstreamId: command.workstreamId,
        userId: attachment.userId,
        substreamId: command.substreamId,
      },
      attributes: {
        "rally.transport": "workspace_socket",
        "rally.message.client_id": command.payload.clientMessageId,
        "rally.message.attachment_count": command.payload.attachmentIds?.length ?? 0,
      },
    }, async (span) => {
      try {
        const authority = await span.step("workstream.message.authority_read", () =>
          readWorkstreamAuthorityControl(this.env));
        if (!acceptsNewWorkstreamWork(authority) || authority.phase !== "durable_object_open") {
          throw new ApiError(503, "workstream_maintenance", "Work streams are temporarily unavailable");
        }
        const auth = await span.step("workstream.message.session_auth", () => this.sessionAuth(attachment));
        if (auth) span.setAttributes(identityAttributes({
          analyticsWorkspaceId: auth.analyticsWorkspaceId,
        }));
        if (!auth) {
          span.setError("session_inactive");
          this.closeSocket(socket, attachment, {
            code: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
            reason: "Session no longer active",
            cause: "session_inactive",
            operation: "create_message",
          });
          return;
        }
        const result = await span.step("workstream.message.object_write", () => new WorkstreamObjectClient(
          this.env,
          auth,
          command.workstreamId,
          command.substreamId,
          true,
        ).createMessage({
          ...command.payload,
          telemetryOperationId: command.operationId,
        }));
        socket.send(JSON.stringify(WorkstreamSocketCommandResultSchema.parse({
          type: "client_command_succeeded",
          command: "create_message",
          clientMessageId: command.payload.clientMessageId,
          ...result,
        })));
        span.mark("workstream.message.respond");
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
        span.setError(safe.code, safe.message);
        span.setAttributes({ "http.response.status_code": safe.status });
      }
    });
  }

  private listSidebarNotes(
    workspaceId: string,
    userId: string,
  ): { items: NoteSummary[]; nextCursor: string | null } {
    return workspaceNoteSidebar(this.state.storage, workspaceId, userId, SIDEBAR_LIST_LIMIT);
  }


  /** Push the current row; missed intermediate rows are intentionally irrelevant. */
  protected async publishWorkstreamState(workstreamId: string, targetUserId?: string): Promise<void> {
    const occurredAt = new Date().toISOString();
    // Viewer-independent: one query for every subscribed socket, not one per socket.
    const preview = loadParticipantPreviews(this.state.storage.sql, [workstreamId]).get(workstreamId);
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
        && (row.origin_type !== "automation" || row.automation_exposed === 1)
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
        workstream: visible ? directoryWorkstream(row, attachment.workspaceId, preview) : null,
      }));
      try {
        socket.send(payload);
      } catch {
        // Hibernation owns close cleanup; reconnect loads the current page and
        // does not need the state rows missed while this socket was unhealthy.
      }
    }
  }

  /**
   * The whole sidebar for one viewer, from three local reads with no `await`
   * between them, so it is one consistent snapshot rather than three answers a
   * concurrent write could land between.
   *
   * `includeSystem` is false and not a parameter: this is the connect payload
   * every window gets, and system rows belong to a debug preference the server
   * does not hold. A client with it on asks for the wider directory afterwards.
   */
  private sidebarPayload(attachment: WorkspaceSocketAttachment): WorkspaceSidebar {
    return WorkspaceSidebarSchema.parse({
      workstreams: listWorkspaceDirectory(this.state.storage, {
        workspaceId: attachment.workspaceId,
        userId: attachment.userId,
        limit: SIDEBAR_LIST_LIMIT,
        includeSystem: false,
      }),
      automations: {
        waterline: this.sidebarListWaterline("automations"),
        items: listSidebarAutomations(this.state.storage, attachment.workspaceId, attachment.userId),
      },
      notes: {
        waterline: this.sidebarListWaterline("notes"),
        ...this.listSidebarNotes(attachment.workspaceId, attachment.userId),
      },
      projects: this.projectSnapshot(attachment.userId),
    });
  }

  private sidebarListWaterline(list: SidebarList): number {
    return this.state.storage.sql.exec<{ waterline: number }>(
      `SELECT waterline FROM workspace_sidebar_list_state WHERE list = ?`,
      list,
    ).one().waterline;
  }

  /**
   * Re-send one sidebar list to every subscribed socket, per viewer.
   *
   * Read once per socket rather than once per workspace because both lists are
   * scoped — a personal automation or note belongs to its owner, and sending
   * one reader's list to another would leak it. This mirrors
   * `publishWorkstreamState`, which re-reads its row per viewer for the same
   * reason.
   *
   * The event carries the list's waterline, read once here so every socket is
   * told the same version of the same read. Transport ordering is not relied on
   * for that: `WorkspaceSidebarListEventSchema` carries the number because the
   * connect payload sends these lists too, and two producers cannot be ordered
   * by one of their transports.
   */
  protected publishSidebarList(list: SidebarList): void {
    const occurredAt = new Date().toISOString();
    const waterline = this.sidebarListWaterline(list);
    // No authorization re-check on the way out. An open socket is closed by the
    // access-revocation queue, never by a publisher asking again — see
    // `docs/access-revocation.md`, which names that as the mechanism it
    // replaced and asks for it not to come back.
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      // The note push carries its cursor so a reader who has paged past the
      // first screen can tell a complete list from its head and merge rather
      // than truncate back to one page.
      const page = list === "automations"
        ? { items: listSidebarAutomations(this.state.storage, attachment.workspaceId, attachment.userId) }
        : this.listSidebarNotes(attachment.workspaceId, attachment.userId);
      try {
        socket.send(JSON.stringify(WorkspaceSidebarListEventSchema.parse({
          type: "workspace_sidebar_list",
          occurredAt,
          list,
          waterline,
          ...page,
        })));
      } catch {
        // Hibernation owns close cleanup, and a reconnect asks for the whole
        // sidebar again, so a socket that missed this list is not left stale.
      }
    }
  }

  /**
   * Re-send both project lists to every subscribed socket, shaped for its user.
   *
   * Project presentation, audience, membership, resource, lifecycle, and order
   * all share the WorkspaceDO project waterline. Sending the complete pair
   * means an audience removal is represented by absence for the removed person,
   * and a reconnect can install exactly the same authoritative state.
   */
  protected publishProjectSnapshot(): void {
    const occurredAt = new Date().toISOString();
    // An open workspace socket is the authorization. Access revocation closes
    // it through the one shared revocation path; do not add a D1 read here.
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      try {
        socket.send(JSON.stringify(WorkspaceProjectSnapshotEventSchema.parse({
          type: "workspace_project_snapshot",
          occurredAt,
          projects: this.projectSnapshot(attachment.userId),
        })));
      } catch {
        // Reconnect receives this same snapshot in the subscribe payload.
      }
    }
  }

  private projectSnapshot(userId: string): ProjectSnapshot {
    return {
      active: this.projectStorage().list(userId),
      inactive: this.projectStorage().listInactive(userId),
    };
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
    // Built once and attached to whichever event this subscribe answers with.
    // Every branch carries it, including the resume where no topic moved: a
    // push can have been missed while the socket was away — a scheduled
    // automation advancing its next run publishes no topic at all — and the
    // client's per-list comparison makes a resume that missed nothing free to
    // ignore.
    const sidebar = this.sidebarPayload(attachment);
    let events: WorkspaceSocketSyncEvent[];
    if (afterWaterline === 0) {
      events = [{
        type: "workspace_sync",
        eventId: uuidV7(),
        waterline: latest,
        occurredAt: new Date().toISOString(),
        topics: [...WORKSPACE_SYNC_TOPICS],
        reason: "initial",
        sidebar,
      }];
    } else if (afterWaterline > latest || (earliest !== null && afterWaterline < earliest - 1)) {
      events = [{
        type: "workspace_sync",
        eventId: uuidV7(),
        waterline: latest,
        occurredAt: new Date().toISOString(),
        topics: [...WORKSPACE_SYNC_TOPICS],
        reason: "history_unavailable",
        sidebar,
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
      events = [WorkspaceSocketSyncEventSchema.parse(newest ? {
        type: "workspace_sync",
        eventId: newest.event_id,
        waterline: newest.waterline,
        occurredAt: new Date(newest.occurred_at).toISOString(),
        topics: WORKSPACE_SYNC_TOPICS.filter((topic) => changedTopics.has(topic)),
        reason: "change",
        sidebar,
      } : {
        // Nothing to report, which is not the same as nothing to send.
        type: "workspace_sync",
        eventId: uuidV7(),
        waterline: latest,
        occurredAt: new Date().toISOString(),
        topics: [],
        reason: "resume",
        sidebar,
      })];
    }
    const featureFlags = await resolveClientFeatureFlagsForSubject(this.env, {
        userId: attachment.userId,
        workspaceId: attachment.workspaceId,
    });
    for (const event of events) {
      socket.send(JSON.stringify(WorkspaceSocketSyncEventSchema.parse({ ...event, featureFlags })));
    }
    socket.serializeAttachment({
      ...attachment,
      subscribed: true,
      lastWaterline: events.at(-1)?.waterline ?? Math.max(afterWaterline, latest),
    });
  }

  private consumeSocketTicket(identity: SocketIdentity): boolean {
    // Ticket claims carry epoch seconds; object SQL stores unix-ms
    // (data-model invariant 7), so convert once at this boundary.
    const now = Date.now();
    const expiresAtMs = identity.ticketExpiresAt * 1_000;
    if (expiresAtMs <= now) return false;
    return this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `DELETE FROM workspace_socket_ticket_receipts WHERE expires_at < ?`,
        now - 300_000,
      );
      const inserted = this.state.storage.sql.exec<{ ticket_id: string }>(
        `INSERT OR IGNORE INTO workspace_socket_ticket_receipts
           (ticket_id, user_id, expires_at, consumed_at)
         VALUES (?, ?, ?, ?)
         RETURNING ticket_id`,
        identity.ticketId,
        identity.userId,
        expiresAtMs,
        now,
      );
      return inserted.toArray().length === 1;
    });
  }

  /**
   * The authorization question every admission and every inbound command asks.
   *
   * Asked on the way in, never on the way out: a socket that is already open is
   * closed by the access-revocation queue rather than by this being re-asked.
   * See `docs/access-revocation.md`.
   */
  private async sessionAuth(identity: Pick<SocketIdentity, "sessionId" | "userId" | "workspaceId">): Promise<AuthContext | null> {
    const role = this.env.APP_ENV === "development"
      && this.env.RALLY_DEV_AUTH === "true"
      && identity.sessionId === "development"
      ? await this.env.DB.prepare(
        `SELECT member.role
           FROM workspace_members member
           JOIN workspaces workspace ON workspace.id = member.workspace_id
          WHERE member.workspace_id = ? AND member.user_id = ?
            AND member.status = 'active' AND workspace.region = ?
            AND workspace.abandoned_at IS NULL`,
      ).bind(identity.workspaceId, identity.userId, this.env.AVALON_REGION)
        .first<WorkspaceAuthRoleRow>()
      : await this.env.DB.prepare(
        // The workspace surrogate rides this query rather than being looked
        // up: a command socket authorizes itself on every frame anyway, and
        // `workspaces` is already joined. The person surrogate is not fetched
        // here — see `docs/performance-tracing.md` for where it comes from.
        `SELECT member.role, workspace.analytics_workspace_id
           FROM sessions session
           JOIN workspace_members member
             ON member.workspace_id = session.workspace_id
            AND member.user_id = session.user_id
            AND member.status = 'active'
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
      ).first<WorkspaceAuthRoleRow>();
    return role ? {
      sessionId: identity.sessionId,
      userId: identity.userId,
      workspaceId: identity.workspaceId,
      region: this.env.AVALON_REGION,
      role: role.role,
      analyticsWorkspaceId: role.analytics_workspace_id ?? null,
    } : null;
  }
}
