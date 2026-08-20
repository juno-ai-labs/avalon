import { jwtVerify, SignJWT } from "jose";
import {
  asBlockId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type BlockId,
  type SubstreamId,
  type UserId,
  type WorkspaceId,
  type WorkstreamId,
} from "@avalon/contracts";
import {
  offersSocketTicketSubprotocol,
  socketTicketFromProtocols,
  SOCKET_TICKET_SUBPROTOCOL,
} from "@avalon/contracts/socket-tickets";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  blockDashboardAgentName,
  substreamAgentName,
  workspaceDOName,
  workstreamDOName,
} from "../durable-objects/names";
import {
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";

const encoder = new TextEncoder();

interface SocketClaims {
  sessionId: string;
  userId: UserId;
  workspaceId: WorkspaceId;
  workstreamId: WorkstreamId;
  substreamId: SubstreamId;
  region: "global" | "eu";
  ticketId: string;
  expiresAt: number;
}

interface WorkspaceSocketClaims {
  sessionId: string;
  userId: UserId;
  workspaceId: WorkspaceId;
  region: "global" | "eu";
  ticketId: string;
  expiresAt: number;
}

interface WorkstreamControlSocketClaims extends WorkspaceSocketClaims {
  workstreamId: WorkstreamId;
}

interface BlockDashboardBlockSocketClaims extends WorkstreamControlSocketClaims {
  blockId: BlockId;
}

export interface TranscriptionSocketClaims {
  userId: UserId;
  workspaceId: WorkspaceId;
  region: "global" | "eu";
  ticketId: string;
  expiresAt: number;
}

function signingKey(env: Env): Uint8Array {
  if (env.SESSION_SIGNING_KEY) return encoder.encode(env.SESSION_SIGNING_KEY);
  if (env.APP_ENV === "development" && env.AVALON_DEV_AUTH === "true") {
    return encoder.encode("avalon-development-session-key-not-for-production");
  }
  throw new ApiError(503, "socket_auth_not_configured", "Realtime authentication is not configured");
}

export async function issueSocketTicket(
  env: Env,
  auth: AuthContext,
  workstreamId: string,
  substreamId = "0",
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    purpose: "workstream_socket",
    sid: auth.sessionId,
    wid: auth.workspaceId,
    wsid: workstreamId,
    ssid: substreamId,
    region: auth.region,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(auth.userId)
    .setJti(uuidV7())
    .setIssuer("avalon-api")
    .setAudience("avalon-workstream-socket")
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(signingKey(env));
}

export async function issueWorkspaceSocketTicket(
  env: Env,
  auth: AuthContext,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    purpose: "workspace_socket",
    sid: auth.sessionId,
    wid: auth.workspaceId,
    region: auth.region,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(auth.userId)
    .setJti(uuidV7())
    .setIssuer("avalon-api")
    .setAudience("avalon-workspace-socket")
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(signingKey(env));
}

export async function verifySocketTicket(env: Env, ticket: string): Promise<SocketClaims> {
  try {
    const { payload } = await jwtVerify(ticket, signingKey(env), {
      algorithms: ["HS256"], issuer: "avalon-api", audience: "avalon-workstream-socket",
    });
    if (
      payload.purpose !== "workstream_socket" || typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.wid !== "string" || typeof payload.wsid !== "string" || typeof payload.ssid !== "string" ||
      typeof payload.jti !== "string" || typeof payload.exp !== "number" ||
      (payload.region !== "global" && payload.region !== "eu")
    ) throw new Error("Incomplete socket claims");
    return {
      sessionId: payload.sid,
      userId: asUserId(payload.sub),
      workspaceId: asWorkspaceId(payload.wid),
      workstreamId: asWorkstreamId(payload.wsid),
      substreamId: asSubstreamId(payload.ssid),
      region: payload.region,
      ticketId: payload.jti,
      expiresAt: payload.exp,
    };
  } catch {
    throw new ApiError(401, "invalid_socket_ticket", "The realtime ticket is invalid or expired");
  }
}

export async function verifyWorkspaceSocketTicket(
  env: Env,
  ticket: string,
): Promise<WorkspaceSocketClaims> {
  try {
    const { payload } = await jwtVerify(ticket, signingKey(env), {
      algorithms: ["HS256"], issuer: "avalon-api", audience: "avalon-workspace-socket",
    });
    if (
      payload.purpose !== "workspace_socket" || typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" || typeof payload.wid !== "string" ||
      typeof payload.jti !== "string" || typeof payload.exp !== "number" ||
      (payload.region !== "global" && payload.region !== "eu")
    ) throw new Error("Incomplete workspace socket claims");
    return {
      sessionId: payload.sid,
      userId: asUserId(payload.sub),
      workspaceId: asWorkspaceId(payload.wid),
      region: payload.region,
      ticketId: payload.jti,
      expiresAt: payload.exp,
    };
  } catch {
    throw new ApiError(401, "invalid_socket_ticket", "The realtime ticket is invalid or expired");
  }
}

export async function issueWorkstreamControlSocketTicket(
  env: Env,
  auth: AuthContext,
  workstreamId: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    purpose: "workstream_control_socket",
    sid: auth.sessionId,
    wid: auth.workspaceId,
    wsid: workstreamId,
    region: auth.region,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(auth.userId)
    .setJti(uuidV7())
    .setIssuer("avalon-api")
    .setAudience("avalon-workstream-control-socket")
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(signingKey(env));
}

export async function issueBlockDashboardBlockSocketTicket(
  env: Env,
  auth: AuthContext,
  workstreamId: string,
  blockId: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    purpose: "block_dashboard_block_socket",
    sid: auth.sessionId,
    wid: auth.workspaceId,
    wsid: workstreamId,
    bid: blockId,
    region: auth.region,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(auth.userId)
    .setJti(uuidV7())
    .setIssuer("avalon-api")
    .setAudience("avalon-block-dashboard-block-socket")
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(signingKey(env));
}

export async function verifyBlockDashboardBlockSocketTicket(
  env: Env,
  ticket: string,
): Promise<BlockDashboardBlockSocketClaims> {
  try {
    const { payload } = await jwtVerify(ticket, signingKey(env), {
      algorithms: ["HS256"], issuer: "avalon-api", audience: "avalon-block-dashboard-block-socket",
    });
    if (
      payload.purpose !== "block_dashboard_block_socket" || typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" || typeof payload.wid !== "string" ||
      typeof payload.wsid !== "string" || typeof payload.bid !== "string" ||
      typeof payload.jti !== "string" || typeof payload.exp !== "number" ||
      (payload.region !== "global" && payload.region !== "eu")
    ) throw new Error("Incomplete HyperSight block socket claims");
    return {
      sessionId: payload.sid,
      userId: asUserId(payload.sub),
      workspaceId: asWorkspaceId(payload.wid),
      workstreamId: asWorkstreamId(payload.wsid),
      blockId: asBlockId(payload.bid),
      region: payload.region,
      ticketId: payload.jti,
      expiresAt: payload.exp,
    };
  } catch {
    throw new ApiError(401, "invalid_socket_ticket", "The realtime ticket is invalid or expired");
  }
}

export async function verifyWorkstreamControlSocketTicket(
  env: Env,
  ticket: string,
): Promise<WorkstreamControlSocketClaims> {
  try {
    const { payload } = await jwtVerify(ticket, signingKey(env), {
      algorithms: ["HS256"], issuer: "avalon-api", audience: "avalon-workstream-control-socket",
    });
    if (
      payload.purpose !== "workstream_control_socket" || typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" || typeof payload.wid !== "string" ||
      typeof payload.wsid !== "string" || typeof payload.jti !== "string" ||
      typeof payload.exp !== "number" || (payload.region !== "global" && payload.region !== "eu")
    ) throw new Error("Incomplete workstream control socket claims");
    return {
      sessionId: payload.sid,
      userId: asUserId(payload.sub),
      workspaceId: asWorkspaceId(payload.wid),
      workstreamId: asWorkstreamId(payload.wsid),
      region: payload.region,
      ticketId: payload.jti,
      expiresAt: payload.exp,
    };
  } catch {
    throw new ApiError(401, "invalid_socket_ticket", "The realtime ticket is invalid or expired");
  }
}

export async function issueTranscriptionSocketTicket(env: Env, auth: AuthContext): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ purpose: "transcription_socket", wid: auth.workspaceId, region: auth.region })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(auth.userId)
    .setJti(uuidV7())
    .setIssuer("avalon-api")
    .setAudience("avalon-transcription-socket")
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(signingKey(env));
}

export async function verifyTranscriptionSocketTicket(
  env: Env,
  ticket: string,
): Promise<TranscriptionSocketClaims> {
  try {
    const { payload } = await jwtVerify(ticket, signingKey(env), {
      algorithms: ["HS256"], issuer: "avalon-api", audience: "avalon-transcription-socket",
    });
    if (
      payload.purpose !== "transcription_socket" || typeof payload.sub !== "string" ||
      typeof payload.wid !== "string" || typeof payload.jti !== "string" ||
      typeof payload.exp !== "number" || (payload.region !== "global" && payload.region !== "eu")
    ) throw new Error("Incomplete transcription socket claims");
    return {
      userId: asUserId(payload.sub),
      workspaceId: asWorkspaceId(payload.wid),
      region: payload.region,
      ticketId: payload.jti,
      expiresAt: payload.exp,
    };
  } catch {
    throw new ApiError(401, "invalid_socket_ticket", "The realtime ticket is invalid or expired");
  }
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/$/u, "");
}

export function isAllowedSocketOrigin(env: Pick<Env, "ALLOWED_ORIGINS">, origin: string | null): boolean {
  if (!origin) return false;
  const requested = normalizeOrigin(origin);
  return env.ALLOWED_ORIGINS
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean)
    .some((allowed) => allowed === requested);
}

/**
 * The ticket the client presented: the `Sec-WebSocket-Protocol` offer when it
 * makes one, otherwise the deprecated query parameter a desktop build released
 * before that scheme still sends. The header wins whenever both are present, so
 * a client that has moved over cannot be downgraded by a URL it did not build.
 */
export function socketTicketFromRequest(request: Request, queryTicket: string | undefined): string {
  const offered = request.headers.get("sec-websocket-protocol");
  // A client that named the scheme is held to it. Falling back to the query
  // when its offer is malformed would let a stale URL credential stand in for
  // the one the client meant to present, which is the opposite of precedence.
  const ticket = offersSocketTicketSubprotocol(offered) ? socketTicketFromProtocols(offered) : queryTicket;
  if (!ticket) {
    throw new ApiError(401, "socket_ticket_required", "The realtime ticket is missing");
  }
  return ticket;
}

/**
 * Chromium fails a handshake where the client offered subprotocols and the
 * server selected none, so the offer has to be answered. Only the sentinel is
 * echoed — returning the ticket would put the credential in a response header
 * and undo the point of moving it out of the URL.
 */
export function withNegotiatedSubprotocol(request: Request, response: Response): Response {
  if (!offersSocketTicketSubprotocol(request.headers.get("sec-websocket-protocol"))) return response;
  // Only an accepted upgrade is negotiated. A room that refuses one answers
  // with a JSON 401, 403, or 500, and rebuilding that as a 101 would replace a
  // readable rejection with a bodyless upgrade carrying no socket — turning
  // ticket replay, the case this whole path exists to refuse, into a broken
  // handshake instead of an error the client can act on.
  if (response.status !== 101 || !response.webSocket) return response;
  const headers = new Headers(response.headers);
  headers.set("sec-websocket-protocol", SOCKET_TICKET_SUBPROTOCOL);
  return new Response(null, { status: 101, webSocket: response.webSocket, headers });
}

export class SocketService {
  constructor(private readonly env: Env) {}

  async upgrade(
    workstreamId: string,
    substreamId: string,
    queryTicket: string | undefined,
    request: Request,
  ): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "websocket_upgrade_required", "A WebSocket upgrade is required");
    }
    if (!isAllowedSocketOrigin(this.env, request.headers.get("origin"))) {
      throw new ApiError(403, "socket_origin_forbidden", "The realtime origin is not allowed");
    }
    const claims = await verifySocketTicket(this.env, socketTicketFromRequest(request, queryTicket));
    if (
      claims.region !== this.env.AVALON_REGION
      || claims.workstreamId !== workstreamId
      || claims.substreamId !== substreamId
    ) {
      throw new ApiError(403, "socket_ticket_scope_mismatch", "The realtime ticket does not authorize this substream");
    }
    const stub = await durableObjectStubForWorkspace(
      this.env,
      this.env.SUBSTREAM_AGENTS,
      claims.workspaceId,
      substreamAgentName(
        claims.region,
        claims.workspaceId,
        claims.workstreamId,
        claims.substreamId,
      ),
    );
    const headers = new Headers(request.headers);
    // The ticket has been verified; the room has no use for it and should not
    // receive a live credential on a subrequest it does not authenticate with.
    headers.delete("sec-websocket-protocol");
    headers.set("x-avalon-workspace-id", claims.workspaceId);
    headers.set("x-avalon-workstream-id", claims.workstreamId);
    headers.set("x-avalon-substream-id", claims.substreamId);
    headers.set("x-avalon-session-id", claims.sessionId);
    headers.set("x-avalon-user-id", claims.userId);
    headers.set("x-avalon-socket-ticket-id", claims.ticketId);
    headers.set("x-avalon-socket-ticket-expires-at", String(claims.expiresAt));
    const response = await stub
      .fetch(new Request("https://room.internal/socket", { method: "GET", headers }));
    // The room answers the upgrade; the subprotocol is negotiated out here so
    // it stays a transport concern the room never has to know about.
    return withNegotiatedSubprotocol(request, response);
  }
}

/** Edge authentication and regional routing for the one workspace sync/command socket. */
export class WorkspaceSocketService {
  constructor(private readonly env: Env) {}

  async upgrade(
    workspaceId: string,
    queryTicket: string | undefined,
    request: Request,
  ): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "websocket_upgrade_required", "A WebSocket upgrade is required");
    }
    if (!isAllowedSocketOrigin(this.env, request.headers.get("origin"))) {
      throw new ApiError(403, "socket_origin_forbidden", "The realtime origin is not allowed");
    }
    const claims = await verifyWorkspaceSocketTicket(
      this.env,
      socketTicketFromRequest(request, queryTicket),
    );
    if (
      claims.region !== this.env.AVALON_REGION
      || claims.workspaceId !== workspaceId
    ) {
      throw new ApiError(403, "socket_ticket_scope_mismatch", "The ticket does not authorize this workspace socket");
    }
    const placementAffinity = await workspacePlacementAffinity(this.env, claims.workspaceId);
    const stub = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      claims.workspaceId,
      workspaceDOName(claims.region, claims.workspaceId),
      placementAffinity,
    );
    const headers = new Headers(request.headers);
    headers.delete("sec-websocket-protocol");
    headers.set("x-avalon-workspace-id", claims.workspaceId);
    headers.set("x-avalon-placement-affinity", placementAffinity);
    headers.set("x-avalon-session-id", claims.sessionId);
    headers.set("x-avalon-user-id", claims.userId);
    headers.set("x-avalon-socket-ticket-id", claims.ticketId);
    headers.set("x-avalon-socket-ticket-expires-at", String(claims.expiresAt));
    const response = await stub.fetch(
      new Request("https://workspace.internal/socket", { method: "GET", headers }),
    );
    return withNegotiatedSubprotocol(request, response);
  }
}

/** Edge authentication and regional routing for one WorkstreamDO metadata socket. */
export class WorkstreamControlSocketService {
  constructor(private readonly env: Env) {}

  async upgrade(
    workstreamId: string,
    queryTicket: string | undefined,
    request: Request,
  ): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "websocket_upgrade_required", "A WebSocket upgrade is required");
    }
    if (!isAllowedSocketOrigin(this.env, request.headers.get("origin"))) {
      throw new ApiError(403, "socket_origin_forbidden", "The realtime origin is not allowed");
    }
    const claims = await verifyWorkstreamControlSocketTicket(
      this.env,
      socketTicketFromRequest(request, queryTicket),
    );
    if (claims.region !== this.env.AVALON_REGION || claims.workstreamId !== workstreamId) {
      throw new ApiError(403, "socket_ticket_scope_mismatch", "The ticket does not authorize this work stream");
    }
    const stub = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSTREAM_DOS,
      claims.workspaceId,
      workstreamDOName(claims.region, claims.workspaceId, claims.workstreamId),
    );
    const headers = new Headers(request.headers);
    headers.delete("sec-websocket-protocol");
    headers.set("x-avalon-workspace-id", claims.workspaceId);
    headers.set("x-avalon-workstream-id", claims.workstreamId);
    headers.set("x-avalon-session-id", claims.sessionId);
    headers.set("x-avalon-user-id", claims.userId);
    headers.set("x-avalon-socket-ticket-id", claims.ticketId);
    headers.set("x-avalon-socket-ticket-expires-at", String(claims.expiresAt));
    const response = await stub.fetch(
      new Request("https://workstream.internal/socket", { method: "GET", headers }),
    );
    return withNegotiatedSubprotocol(request, response);
  }
}

/** Edge authentication and regional routing for one HyperSight block agent socket. */
export class BlockDashboardBlockSocketService {
  constructor(private readonly env: Env) {}

  async upgrade(
    workstreamId: string,
    blockId: string,
    queryTicket: string | undefined,
    request: Request,
  ): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "websocket_upgrade_required", "A WebSocket upgrade is required");
    }
    if (!isAllowedSocketOrigin(this.env, request.headers.get("origin"))) {
      throw new ApiError(403, "socket_origin_forbidden", "The realtime origin is not allowed");
    }
    const claims = await verifyBlockDashboardBlockSocketTicket(
      this.env,
      socketTicketFromRequest(request, queryTicket),
    );
    if (
      claims.region !== this.env.AVALON_REGION
      || claims.workstreamId !== workstreamId
      || claims.blockId !== blockId
    ) {
      throw new ApiError(403, "socket_ticket_scope_mismatch", "The ticket does not authorize this HyperSight block");
    }
    const stub = await durableObjectStubForWorkspace(
      this.env,
      this.env.BLOCK_DASHBOARD_AGENTS,
      claims.workspaceId,
      blockDashboardAgentName(
        claims.region,
        claims.workspaceId,
        claims.workstreamId,
        claims.blockId,
      ),
    );
    await stub.initializeBlock({
      region: claims.region,
      workspaceId: claims.workspaceId,
      workstreamId: claims.workstreamId,
      blockId: claims.blockId,
    });
    const headers = new Headers(request.headers);
    headers.delete("sec-websocket-protocol");
    headers.set("x-avalon-region", claims.region);
    headers.set("x-avalon-workspace-id", claims.workspaceId);
    headers.set("x-avalon-workstream-id", claims.workstreamId);
    headers.set("x-avalon-block-dashboard-block-id", claims.blockId);
    headers.set("x-avalon-session-id", claims.sessionId);
    headers.set("x-avalon-user-id", claims.userId);
    headers.set("x-avalon-socket-ticket-id", claims.ticketId);
    headers.set("x-avalon-socket-ticket-expires-at", String(claims.expiresAt));
    const response = await stub.fetch(new Request(
      "https://block-dashboard.internal/socket",
      { method: "GET", headers },
    ));
    return withNegotiatedSubprotocol(request, response);
  }
}
