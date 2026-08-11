import { jwtVerify, SignJWT } from "jose";
import {
  offersSocketTicketSubprotocol,
  socketTicketFromProtocols,
  SOCKET_TICKET_SUBPROTOCOL,
} from "@avalon/contracts/socket-tickets";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";

const encoder = new TextEncoder();

interface SocketClaims {
  userId: string;
  workspaceId: string;
  workstreamId: string;
  region: "global" | "eu";
  ticketId: string;
  expiresAt: number;
}

export interface TranscriptionSocketClaims {
  userId: string;
  workspaceId: string;
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

export async function issueSocketTicket(env: Env, auth: AuthContext, workstreamId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ purpose: "workstream_socket", wid: auth.workspaceId, wsid: workstreamId, region: auth.region })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(auth.userId)
    .setJti(crypto.randomUUID())
    .setIssuer("avalon-api")
    .setAudience("avalon-workstream-socket")
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
      typeof payload.wid !== "string" || typeof payload.wsid !== "string" ||
      typeof payload.jti !== "string" || typeof payload.exp !== "number" ||
      (payload.region !== "global" && payload.region !== "eu")
    ) throw new Error("Incomplete socket claims");
    return {
      userId: payload.sub,
      workspaceId: payload.wid,
      workstreamId: payload.wsid,
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
    .setJti(crypto.randomUUID())
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
      userId: payload.sub,
      workspaceId: payload.wid,
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
  const ticket = socketTicketFromProtocols(request.headers.get("sec-websocket-protocol")) ?? queryTicket;
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
  const headers = new Headers(response.headers);
  headers.set("sec-websocket-protocol", SOCKET_TICKET_SUBPROTOCOL);
  return new Response(null, { status: 101, webSocket: response.webSocket, headers });
}

export class SocketService {
  constructor(private readonly env: Env) {}

  async upgrade(workstreamId: string, queryTicket: string | undefined, request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "websocket_upgrade_required", "A WebSocket upgrade is required");
    }
    if (!isAllowedSocketOrigin(this.env, request.headers.get("origin"))) {
      throw new ApiError(403, "socket_origin_forbidden", "The realtime origin is not allowed");
    }
    const claims = await verifySocketTicket(this.env, socketTicketFromRequest(request, queryTicket));
    if (claims.region !== this.env.AVALON_REGION || claims.workstreamId !== workstreamId) {
      throw new ApiError(403, "socket_ticket_scope_mismatch", "The realtime ticket does not authorize this work stream");
    }
    const rooms = durableObjectNamespaceForRegion(this.env.WORKSTREAM_ROOMS, claims.region, this.env.APP_ENV);
    const durableId = rooms.idFromName(`${this.env.AVALON_REGION}:${claims.workspaceId}:${claims.workstreamId}`);
    const headers = new Headers(request.headers);
    headers.set("x-avalon-workspace-id", claims.workspaceId);
    headers.set("x-avalon-workstream-id", claims.workstreamId);
    headers.set("x-avalon-user-id", claims.userId);
    headers.set("x-avalon-socket-ticket-id", claims.ticketId);
    headers.set("x-avalon-socket-ticket-expires-at", String(claims.expiresAt));
    const response = await rooms.get(durableId)
      .fetch(new Request("https://room.internal/socket", { method: "GET", headers }));
    // The room answers the upgrade; the subprotocol is negotiated out here so
    // it stays a transport concern the room never has to know about.
    return withNegotiatedSubprotocol(request, response);
  }
}
