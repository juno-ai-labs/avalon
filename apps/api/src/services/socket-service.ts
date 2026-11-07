import { isConfiguredRegion } from "@rally/contracts/regions";
import { TRANSCRIPTION_TICKET_LIFETIME_SECONDS } from "@rally/contracts/realtime-transcription";
import type { Region } from "@rally/contracts/regions";
import { RESOLUTION_SUGGESTIONS_CLIENT_CONTRACT, RALLY_HEADERS, rallyHeaderAliases, readRallyHeader } from "@rally/contracts/http-headers";
import { jwtVerify, SignJWT } from "jose";
import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  type SubstreamId,
  type UserId,
  type WorkspaceId,
} from "@rally/contracts";
import type { ConversationParentKind } from "@rally/contracts/conversation-parent";
import {
  negotiatedSocketTicketSubprotocol,
  offersSocketTicketSubprotocol,
  socketTicketFromProtocols,
} from "@rally/contracts/socket-tickets";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { inFlowSpan } from "../observability/tracing";
import {
  conversationObjectName,
  workspaceDOName,
} from "../durable-objects/names";
import {
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";

const encoder = new TextEncoder();
export const WORKSTREAM_SOCKET_TICKET_TTL_SECONDS = 60;

interface SocketClaims {
  sessionId: string;
  userId: UserId;
  workspaceId: WorkspaceId;
  /** The conversation's parent, of either kind, and its id. */
  parentKind: ConversationParentKind;
  parentId: string;
  substreamId: SubstreamId;
  region: Region;
  ticketId: string;
  expiresAt: number;
  afterSequence?: number;
  speculative?: true;
  admission?: WorkstreamSocketAdmission;
  readsResolutionSuggestions?: boolean;
  /** The staff member behind a support session (`docs/impersonation.md`). */
  impersonatorUserId?: UserId;
}

export interface WorkstreamSocketAdmission {
  version: 1;
  authorityGeneration: number;
  role: AuthContext["role"];
  analyticsWorkspaceId: string | null;
  /**
   * The parent said it is archived. The conversation admits the reader and
   * refuses their writes: a child never outlives its parent's archive.
   */
  parentArchived: boolean;
  /** Parent-issued participant projection revision after migration; legacy membership version otherwise. */
  membershipVersion?: number;
}

export interface IssueWorkstreamSocketTicketOptions {
  admission?: Omit<WorkstreamSocketAdmission, "version">;
  issuedAt?: number;
  readsResolutionSuggestions?: boolean;
}

interface WorkspaceSocketClaims {
  sessionId: string;
  userId: UserId;
  workspaceId: WorkspaceId;
  region: Region;
  ticketId: string;
  expiresAt: number;
  /** The staff member behind a support session (`docs/impersonation.md`). */
  impersonatorUserId?: UserId;
  /** Whether the build that asked for this ticket reads a Space scoped `individual`. */
  readsIndividualSpaces?: boolean;
}

export interface TranscriptionSocketClaims {
  userId: UserId;
  workspaceId: WorkspaceId;
  region: Region;
  ticketId: string;
  expiresAt: number;
}

function signingKey(env: Env): Uint8Array {
  if (env.SESSION_SIGNING_KEY) return encoder.encode(env.SESSION_SIGNING_KEY);
  if (env.APP_ENV === "development" && env.RALLY_DEV_AUTH === "true") {
    return encoder.encode("avalon-development-session-key-not-for-production");
  }
  throw new ApiError(503, "socket_auth_not_configured", "Realtime authentication is not configured");
}

/**
 * A socket ticket is a session credential: admission stores its `sid` on the
 * attachment, and the access-revocation queue matches that id against real
 * `sessions` rows to close what a logout revoked. A connector or demo-seed
 * principal has no session behind its correlation id, so a ticket minted from
 * one would be admitted for reads and then closeable by no session revocation
 * — the documented invariant is that sockets never carry a non-session
 * principal, and this is where it is enforced rather than assumed.
 */
function assertSessionPrincipal(auth: AuthContext): void {
  if (auth.principal !== undefined) {
    throw new ApiError(
      403,
      "non_session_principal_cannot_hold_socket",
      "This action requires a signed-in session",
    );
  }
}

/**
 * `ticketId` is accepted rather than only generated so the issuing route can
 * log the same id the room later reports consuming. It is the only identifier
 * shared by the two: a socket upgrade is a new connection carrying no request
 * id, so without it a slow room cannot be traced back to the client that asked
 * for the ticket.
 */
export async function issueSocketTicket(
  env: Env,
  auth: AuthContext,
  parent: { kind: ConversationParentKind; id: string },
  substreamId = "0",
  ticketId: string = uuidV7(),
  afterSequence?: number,
  speculative = false,
  options: IssueWorkstreamSocketTicketOptions = {},
): Promise<string> {
  assertSessionPrincipal(auth);
  // A Space's conversation is a storage detail of the Space, not a product
  // surface: it has no composer, no transcript and no Main link, and the
  // object it belongs to refuses the upgrade a ticket would be spent on. The
  // refusal is here as well as there because a ticket is a signed credential —
  // minting one for a conversation nothing may open is the kind of thing that
  // is later mistaken for authorization.
  if (parent.kind === "space") {
    throw new ApiError(403, "space_feed_socket_refused",
      "A channel has no conversation feed to open");
  }
  const now = options.issuedAt ?? Math.floor(Date.now() / 1_000);
  return new SignJWT({
    purpose: "workstream_socket",
    ...(options.readsResolutionSuggestions ? { resolution_suggestions: true } : {}),
    sid: auth.sessionId,
    wid: auth.workspaceId,
    pk: parent.kind,
    wsid: parent.id,
    ssid: substreamId,
    region: auth.region,
    ...(afterSequence === undefined ? {} : { after: afterSequence }),
    ...(speculative ? { warm: true } : {}),
    ...(auth.impersonatorUserId ? { imp: auth.impersonatorUserId } : {}),
    ...(options.admission ? {
      admission: 1,
      authority_generation: options.admission.authorityGeneration,
      role: options.admission.role,
      analytics_workspace_id: options.admission.analyticsWorkspaceId,
      membership_version: options.admission.membershipVersion ?? 0,
      ...(options.admission.parentArchived ? { parent_archived: true } : {}),
    } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(auth.userId)
    .setJti(ticketId)
    .setIssuer("avalon-api")
    .setAudience("avalon-workstream-socket")
    .setIssuedAt(now)
    .setExpirationTime(now + WORKSTREAM_SOCKET_TICKET_TTL_SECONDS)
    .sign(signingKey(env));
}

export async function issueWorkspaceSocketTicket(
  env: Env,
  auth: AuthContext,
  options: { readsIndividualSpaces: boolean } = { readsIndividualSpaces: false },
): Promise<string> {
  assertSessionPrincipal(auth);
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    purpose: "workspace_socket",
    sid: auth.sessionId,
    wid: auth.workspaceId,
    region: auth.region,
    ...(auth.impersonatorUserId ? { imp: auth.impersonatorUserId } : {}),
    ...(options.readsIndividualSpaces ? { ind: true } : {}),
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
      (payload.pk !== "workstream" && payload.pk !== "automation" && payload.pk !== "canvas") ||
      typeof payload.jti !== "string" || typeof payload.exp !== "number" ||
      !isConfiguredRegion(payload.region)
    ) throw new Error("Incomplete socket claims");
    const afterSequence = typeof payload.after === "number"
      && Number.isInteger(payload.after)
      && payload.after >= 0
      ? payload.after
      : undefined;
    const speculative = payload.warm === true;
    let admission: WorkstreamSocketAdmission | undefined;
    if (payload.admission !== undefined) {
      if (
        payload.admission !== 1
        || typeof payload.authority_generation !== "number"
        || !Number.isInteger(payload.authority_generation)
        || payload.authority_generation < 0
        || (payload.membership_version !== undefined
          && (typeof payload.membership_version !== "number"
            || !Number.isInteger(payload.membership_version)
            || payload.membership_version < 0))
        || (payload.role !== null && payload.role !== "owner" && payload.role !== "admin" && payload.role !== "member")
        || (payload.analytics_workspace_id !== null
          && typeof payload.analytics_workspace_id !== "string")
      ) throw new Error("Incomplete socket admission claims");
      admission = {
        version: 1,
        authorityGeneration: payload.authority_generation,
        role: payload.role,
        analyticsWorkspaceId: payload.analytics_workspace_id,
        parentArchived: payload.parent_archived === true,
        membershipVersion: typeof payload.membership_version === "number" ? payload.membership_version : 0,
      };
    }
    return {
      sessionId: payload.sid,
      userId: asUserId(payload.sub),
      workspaceId: asWorkspaceId(payload.wid),
      parentKind: payload.pk,
      parentId: payload.wsid,
      substreamId: asSubstreamId(payload.ssid),
      region: payload.region,
      ticketId: payload.jti,
      expiresAt: payload.exp,
      readsResolutionSuggestions: payload.resolution_suggestions === true,
      ...(afterSequence === undefined ? {} : { afterSequence }),
      ...(speculative ? { speculative: true as const } : {}),
      ...(admission ? { admission } : {}),
      ...(typeof payload.imp === "string" ? { impersonatorUserId: asUserId(payload.imp) } : {}),
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
      !isConfiguredRegion(payload.region)
    ) throw new Error("Incomplete workspace socket claims");
    return {
      sessionId: payload.sid,
      userId: asUserId(payload.sub),
      workspaceId: asWorkspaceId(payload.wid),
      region: payload.region,
      ticketId: payload.jti,
      expiresAt: payload.exp,
      ...(typeof payload.imp === "string" ? { impersonatorUserId: asUserId(payload.imp) } : {}),
      readsIndividualSpaces: payload.ind === true,
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
    .setExpirationTime(now + TRANSCRIPTION_TICKET_LIFETIME_SECONDS)
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
      typeof payload.exp !== "number" || !isConfiguredRegion(payload.region)
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
 * server selected none, so the offer has to be answered. The sentinel echoed is
 * the one the client offered, canonical or superseded — selecting a spelling it
 * never sent fails the handshake just as selecting none does. Only the sentinel
 * is echoed — returning the ticket would put the credential in a response header
 * and undo the point of moving it out of the URL.
 */
export function withNegotiatedSubprotocol(request: Request, response: Response): Response {
  const offered = negotiatedSocketTicketSubprotocol(request.headers.get("sec-websocket-protocol"));
  if (offered === null) return response;
  // Only an accepted upgrade is negotiated. A room that refuses one answers
  // with a JSON 401, 403, or 500, and rebuilding that as a 101 would replace a
  // readable rejection with a bodyless upgrade carrying no socket — turning
  // ticket replay, the case this whole path exists to refuse, into a broken
  // handshake instead of an error the client can act on.
  if (response.status !== 101 || !response.webSocket) return response;
  const headers = new Headers(response.headers);
  headers.set("sec-websocket-protocol", offered);
  return new Response(null, { status: 101, webSocket: response.webSocket, headers });
}

/**
 * Separate the edge's total wait from the room's accept handler duration.
 * The remainder includes routing, activation, constructor/storage readiness,
 * and queueing; it cannot identify platform activation alone. Instance age is
 * context, not a duration to subtract (another call may have woken the room).
 * Internal headers are stripped independently of whether their values parse.
 * Rejections remain untouched, as in `withNegotiatedSubprotocol`.
 */
export function roomUpgradeDiagnostics(
  response: Response,
  roomUpgradeMs: number,
): { attributes: Record<string, number>; response: Response } {
  const acceptMs = nonNegativeInteger(readRallyHeader(response.headers, RALLY_HEADERS.ROOM_ACCEPT_MS));
  const instanceAgeMs = nonNegativeInteger(
    readRallyHeader(response.headers, RALLY_HEADERS.ROOM_INSTANCE_AGE_MS),
  );
  const attributes: Record<string, number> = {};
  if (acceptMs !== undefined) {
    attributes["rally.socket.room_accept_ms"] = acceptMs;
    attributes["rally.socket.room_outside_accept_ms"] = Math.max(0, roomUpgradeMs - acceptMs);
  }
  if (instanceAgeMs !== undefined) attributes["rally.socket.room_instance_age_ms"] = instanceAgeMs;
  const diagnosticNames = [
    ...rallyHeaderAliases(RALLY_HEADERS.ROOM_ACCEPT_MS),
    ...rallyHeaderAliases(RALLY_HEADERS.ROOM_INSTANCE_AGE_MS),
  ];
  if (
    !diagnosticNames.some((name) => response.headers.has(name))
    || response.status !== 101
    || !response.webSocket
  ) {
    return { attributes, response };
  }
  const headers = new Headers(response.headers);
  for (const name of diagnosticNames) headers.delete(name);
  return {
    attributes,
    response: new Response(null, { status: 101, webSocket: response.webSocket, headers }),
  };
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}

export class SocketService {
  constructor(private readonly env: Env) {}

  async upgrade(
    parentId: string,
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
      || claims.parentId !== parentId
      || claims.substreamId !== substreamId
    ) {
      throw new ApiError(403, "socket_ticket_scope_mismatch", "The realtime ticket does not authorize this substream");
    }
    // A WebSocket upgrade is its own invocation, and the browser can attach no
    // header to the handshake, so nothing links this trace to the request that
    // issued the ticket except the ticket id — which the issuing route records
    // under the same attribute name. The span starts once the claims are
    // readable; a rejected ticket is already an `http_request` row of its own.
    return inFlowSpan(this.env, "workstream.socket.upgrade", {
      flow: "workstream_open",
      component: "api_socket",
      identity: {
        workspaceId: claims.workspaceId,
        workstreamId: claims.parentId,
        userId: claims.userId,
        sessionId: claims.sessionId,
        substreamId: claims.substreamId,
      },
      attributes: {
        "rally.socket.ticket_id": claims.ticketId,
        ...(claims.afterSequence === undefined ? {} : {
          "rally.socket.after_sequence": claims.afterSequence,
        }),
        ...(claims.speculative ? { "rally.socket.speculative": true } : {}),
      },
    }, async (span) => {
      const stub = await span.step("workstream.socket.room_stub", () => durableObjectStubForWorkspace(
        this.env,
        this.env.SUBSTREAM_AGENTS,
        claims.workspaceId,
        conversationObjectName(
          claims.region,
          claims.workspaceId,
          claims.parentId,
          claims.substreamId,
        ),
      ));
      const headers = new Headers(request.headers);
      headers.set(RALLY_HEADERS.CLIENT_CONTRACT, claims.readsResolutionSuggestions ? String(RESOLUTION_SUGGESTIONS_CLIENT_CONTRACT) : "0");
      // The ticket has been verified; the room has no use for it and should not
      // receive a live credential on a subrequest it does not authenticate with.
      headers.delete("sec-websocket-protocol");
      headers.set(RALLY_HEADERS.WORKSPACE_ID, claims.workspaceId);
      headers.set(RALLY_HEADERS.WORKSTREAM_ID, claims.parentId);
      headers.set(RALLY_HEADERS.PARENT_ID, claims.parentId);
      headers.set(RALLY_HEADERS.PARENT_KIND, claims.parentKind);
      headers.set(RALLY_HEADERS.SUBSTREAM_ID, claims.substreamId);
      headers.set(RALLY_HEADERS.SESSION_ID, claims.sessionId);
      headers.set(RALLY_HEADERS.USER_ID, claims.userId);
      headers.set(RALLY_HEADERS.SOCKET_TICKET_ID, claims.ticketId);
      headers.set(RALLY_HEADERS.SOCKET_TICKET_EXPIRES_AT, String(claims.expiresAt));
      // These two are decisions signed into the ticket. Clear every inbound
      // spelling before adding the verified values so a native client cannot
      // smuggle an unsigned cursor or speculative mode through the copied
      // upgrade headers when the corresponding claim is absent.
      for (const name of [
        ...rallyHeaderAliases(RALLY_HEADERS.SOCKET_ADMISSION_AUTHORITY_GENERATION),
        ...rallyHeaderAliases(RALLY_HEADERS.SOCKET_ADMISSION_ROLE),
        ...rallyHeaderAliases(RALLY_HEADERS.SOCKET_ADMISSION_VERSION),
        ...rallyHeaderAliases(RALLY_HEADERS.SOCKET_ADMISSION_MEMBERSHIP_VERSION),
        ...rallyHeaderAliases(RALLY_HEADERS.SOCKET_ANALYTICS_WORKSPACE_ID),
        ...rallyHeaderAliases(RALLY_HEADERS.SOCKET_AFTER_SEQUENCE),
        ...rallyHeaderAliases(RALLY_HEADERS.SOCKET_SPECULATIVE),
        ...rallyHeaderAliases(RALLY_HEADERS.PARENT_ARCHIVED),
        ...rallyHeaderAliases(RALLY_HEADERS.SOCKET_IMPERSONATOR_ID),
      ]) headers.delete(name);
      if (claims.impersonatorUserId) headers.set(RALLY_HEADERS.SOCKET_IMPERSONATOR_ID, claims.impersonatorUserId);
      if (claims.afterSequence !== undefined) {
        headers.set(RALLY_HEADERS.SOCKET_AFTER_SEQUENCE, String(claims.afterSequence));
      }
      if (claims.speculative) headers.set(RALLY_HEADERS.SOCKET_SPECULATIVE, "true");
      if (claims.admission) {
        headers.set(RALLY_HEADERS.SOCKET_ADMISSION_VERSION, String(claims.admission.version));
        headers.set(
          RALLY_HEADERS.SOCKET_ADMISSION_AUTHORITY_GENERATION,
          String(claims.admission.authorityGeneration),
        );
        headers.set(RALLY_HEADERS.SOCKET_ADMISSION_ROLE, claims.admission.role ?? "null");
        headers.set(
          RALLY_HEADERS.SOCKET_ADMISSION_MEMBERSHIP_VERSION,
          String(claims.admission.membershipVersion ?? 0),
        );
        if (claims.admission.parentArchived) headers.set(RALLY_HEADERS.PARENT_ARCHIVED, "true");
        if (claims.admission.analyticsWorkspaceId !== null) {
          headers.set(
            RALLY_HEADERS.SOCKET_ANALYTICS_WORKSPACE_ID,
            claims.admission.analyticsWorkspaceId,
          );
        }
      }
      // No trace header is written: the room's spans are already children of
      // this one, because a Durable Object call is a traced binding call and
      // everything inside it runs in this span's async context.
      // Timed on the same pinned clock the step uses, so the two agree to the
      // millisecond: this wait, less what the room says its accept took, is
      // time outside the accept handler — see `roomUpgradeDiagnostics`.
      const roomUpgradeStartedAt = Date.now();
      const roomResponse = await span.step("workstream.socket.room_upgrade", () => stub
        .fetch(new Request("https://room.internal/socket", { method: "GET", headers })));
      const { attributes, response } = roomUpgradeDiagnostics(
        roomResponse,
        Date.now() - roomUpgradeStartedAt,
      );
      span.setAttributes({ "http.response.status_code": response.status, ...attributes });
      // The room answers the upgrade; the subprotocol is negotiated out here so
      // it stays a transport concern the room never has to know about.
      return withNegotiatedSubprotocol(request, response);
    });
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
    headers.set(RALLY_HEADERS.WORKSPACE_ID, claims.workspaceId);
    headers.set(RALLY_HEADERS.PLACEMENT_AFFINITY, placementAffinity);
    headers.set(RALLY_HEADERS.SESSION_ID, claims.sessionId);
    headers.set(RALLY_HEADERS.USER_ID, claims.userId);
    headers.set(RALLY_HEADERS.SOCKET_TICKET_ID, claims.ticketId);
    headers.set(RALLY_HEADERS.SOCKET_TICKET_EXPIRES_AT, String(claims.expiresAt));
    for (const name of rallyHeaderAliases(RALLY_HEADERS.SOCKET_IMPERSONATOR_ID)) headers.delete(name);
    if (claims.impersonatorUserId) headers.set(RALLY_HEADERS.SOCKET_IMPERSONATOR_ID, claims.impersonatorUserId);
    for (const name of rallyHeaderAliases(RALLY_HEADERS.SOCKET_READS_INDIVIDUAL_SPACES)) headers.delete(name);
    if (claims.readsIndividualSpaces) headers.set(RALLY_HEADERS.SOCKET_READS_INDIVIDUAL_SPACES, "1");
    const response = await stub.fetch(
      new Request("https://workspace.internal/socket", { method: "GET", headers }),
    );
    return withNegotiatedSubprotocol(request, response);
  }
}

