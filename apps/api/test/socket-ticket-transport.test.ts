import { asUserId, asWorkspaceId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { socketTicketProtocols, SOCKET_TICKET_SUBPROTOCOL } from "@rally/contracts/socket-tickets";
import { ApiError } from "../src/lib/api-error";
import {
  BlockDashboardBlockSocketService,
  issueBlockDashboardBlockSocketTicket,
  issueSocketTicket,
  issueWorkstreamControlSocketTicket,
  issueWorkspaceSocketTicket,
  SocketService,
  socketTicketFromRequest,
  verifySocketTicket,
  verifyBlockDashboardBlockSocketTicket,
  verifyWorkstreamControlSocketTicket,
  verifyWorkspaceSocketTicket,
  withNegotiatedSubprotocol,
  WorkspaceSocketService,
  WorkstreamControlSocketService,
} from "../src/services/socket-service";
import type { Env } from "../src/env";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

// Shaped like the compact JWS a ticket really is — dot-separated base64url —
// but without the `eyJ` header that makes a secret scanner read a fixture as a
// live token. Nothing under test parses the structure: the transport only cares
// that the token is in the character class and length a subprotocol allows.
const TICKET = "dGlja2V0LWhlYWRlcg.dGlja2V0LXBheWxvYWQ.dGlja2V0LXNpZ25hdHVyZQ";
const OLD_TICKET = "b2xkLWhlYWRlcg.b2xkLXBheWxvYWQ.b2xkLXNpZ25hdHVyZQ";

// workerd allows a 101 Response; Node's does not, so the runtime the Worker
// actually runs on is stood in for the same way the transcription proxy suite
// does it.
class FakeResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly webSocket: WebSocket | undefined;

  constructor(_body: BodyInit | null, init: ResponseInit & { webSocket?: WebSocket } = {}) {
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    this.webSocket = init.webSocket;
  }
}

function upgradeResponse(): Response {
  return new FakeResponse(null, {
    status: 101,
    webSocket: {} as unknown as WebSocket,
  }) as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

function upgradeRequest(protocols?: string[]): Request {
  const headers = new Headers({ Origin: "app://avalon", Upgrade: "websocket" });
  if (protocols) headers.set("sec-websocket-protocol", protocols.join(", "));
  return { headers } as Request;
}

describe("socket ticket transport", () => {
  it("forwards the verified session identity, but not the bearer ticket, to the room", async () => {
    const sessionId = "00000000-0000-7000-8000-000000000701";
    const userId = asUserId("00000000-0000-7000-8000-000000000702");
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000703");
    const workstreamId = "00000000-0000-7000-8000-000000000704";
    const roomFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("x-rally-session-id")).toBe(sessionId);
      expect(request.headers.get("x-rally-user-id")).toBe(userId);
      expect(request.headers.get("sec-websocket-protocol")).toBeNull();
      return Response.json({ error: "socket_ticket_replayed" }, { status: 401 });
    });
    const env = createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      ALLOWED_ORIGINS: "app://avalon",
      SESSION_SIGNING_KEY: "socket-ticket-test-signing-key",
      SUBSTREAM_AGENTS: createCloudflareTestBinding<DurableObjectNamespace>({
        idFromName: () => createTestDurableObjectId("room-id"),
        get: () => ({ fetch: roomFetch }),
      }),
    });
    const ticket = await issueSocketTicket(env, {
      sessionId,
      userId,
      workspaceId,
      region: "global",
      role: "member",
    }, workstreamId);
    const request = new Request(`https://api.avalon.test/workstreams/${workstreamId}/socket`, {
      headers: {
        Origin: "app://avalon",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": socketTicketProtocols(ticket).join(", "),
      },
    });

    const response = await new SocketService(env).upgrade(workstreamId, "0", undefined, request);

    expect(response.status).toBe(401);
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it("refuses to mint any socket ticket for a connector principal", async () => {
    // A socket ticket is a session credential: admission stores its `sid`, and
    // the access-revocation queue closes sockets by matching that id against
    // real `sessions` rows. A connector principal's correlation id matches no
    // session, so a ticket minted from one would open a read feed that no
    // session revocation could ever close. The documented invariant — sockets
    // never carry a connector principal — is enforced at the mint, and this is
    // the assertion behind it.
    const env = createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      SESSION_SIGNING_KEY: "socket-ticket-test-signing-key",
    });
    const connector = {
      sessionId: "slack:T123:U456",
      userId: asUserId("00000000-0000-7000-8000-000000000722"),
      workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000723"),
      region: "global" as const,
      role: "member" as const,
      principal: "connector" as const,
    };
    const refusal = { status: 403, code: "connector_principal_cannot_hold_socket" };

    await expect(issueSocketTicket(env, connector, "00000000-0000-7000-8000-000000000724"))
      .rejects.toMatchObject(refusal);
    await expect(issueWorkspaceSocketTicket(env, connector)).rejects.toMatchObject(refusal);
    await expect(issueWorkstreamControlSocketTicket(env, connector, "00000000-0000-7000-8000-000000000724"))
      .rejects.toMatchObject(refusal);
    await expect(issueBlockDashboardBlockSocketTicket(
      env,
      connector,
      "00000000-0000-7000-8000-000000000724",
      "00000000-0000-7000-8000-000000000725",
    )).rejects.toMatchObject(refusal);
  });

  it("routes one workspace-scoped sync and command ticket to WorkspaceDO", async () => {
    const sessionId = "00000000-0000-7000-8000-000000000711";
    const userId = asUserId("00000000-0000-7000-8000-000000000712");
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000713");
    const workspaceFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("x-rally-workspace-id")).toBe(workspaceId);
      expect(request.headers.get("x-rally-placement-affinity")).toBe("wnam");
      expect(request.headers.get("x-rally-workstream-id")).toBeNull();
      expect(request.headers.get("x-rally-substream-id")).toBeNull();
      expect(request.headers.get("x-rally-session-id")).toBe(sessionId);
      expect(request.headers.get("sec-websocket-protocol")).toBeNull();
      return Response.json({ error: "socket_ticket_replayed" }, { status: 401 });
    });
    const workspaceNamespace = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: () => createTestDurableObjectId("workspace-do-id"),
      get: () => ({ fetch: workspaceFetch }),
    });
    const env = createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      ALLOWED_ORIGINS: "app://avalon",
      SESSION_SIGNING_KEY: "socket-ticket-test-signing-key",
      WORKSPACE_DOS: workspaceNamespace,
    });
    const auth = { sessionId, userId, workspaceId, region: "global", role: "member" } as const;
    const ticket = await issueWorkspaceSocketTicket(env, auth);
    const request = new Request(`https://api.avalon.test/workspaces/${workspaceId}`, {
      headers: {
        Origin: "app://avalon",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": socketTicketProtocols(ticket).join(", "),
      },
    });

    const response = await new WorkspaceSocketService(env).upgrade(
      workspaceId,
      undefined,
      request,
    );

    expect(response.status).toBe(401);
    expect(workspaceFetch).toHaveBeenCalledOnce();
    await expect(verifySocketTicket(env, ticket)).rejects.toMatchObject({ code: "invalid_socket_ticket" });
    await expect(verifyWorkspaceSocketTicket(env, ticket)).resolves.toMatchObject({
      workspaceId,
    });
  });

  it("routes a separately scoped metadata ticket to WorkstreamDO", async () => {
    const sessionId = "00000000-0000-7000-8000-000000000721";
    const userId = asUserId("00000000-0000-7000-8000-000000000722");
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000723");
    const workstreamId = "00000000-0000-7000-8000-000000000724";
    const workstreamFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("x-rally-workspace-id")).toBe(workspaceId);
      expect(request.headers.get("x-rally-workstream-id")).toBe(workstreamId);
      expect(request.headers.get("x-rally-session-id")).toBe(sessionId);
      expect(request.headers.get("sec-websocket-protocol")).toBeNull();
      return Response.json({ error: "socket_ticket_replayed" }, { status: 401 });
    });
    const env = createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      ALLOWED_ORIGINS: "app://avalon",
      SESSION_SIGNING_KEY: "socket-ticket-test-signing-key",
      WORKSTREAM_DOS: createCloudflareTestBinding<Env["WORKSTREAM_DOS"]>({
        idFromName: () => createTestDurableObjectId("workstream-do-id"),
        get: () => ({ fetch: workstreamFetch }),
      }),
    });
    const auth = { sessionId, userId, workspaceId, region: "global", role: "member" } as const;
    const ticket = await issueWorkstreamControlSocketTicket(env, auth, workstreamId);
    const request = new Request(`https://api.avalon.test/workstreams/${workstreamId}`, {
      headers: {
        Origin: "app://avalon",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": socketTicketProtocols(ticket).join(", "),
      },
    });

    const response = await new WorkstreamControlSocketService(env).upgrade(
      workstreamId,
      undefined,
      request,
    );

    expect(response.status).toBe(401);
    expect(workstreamFetch).toHaveBeenCalledOnce();
    await expect(verifyWorkstreamControlSocketTicket(env, ticket)).resolves.toMatchObject({
      workspaceId,
      workstreamId,
    });
    await expect(verifyWorkspaceSocketTicket(env, ticket))
      .rejects.toMatchObject({ code: "invalid_socket_ticket" });
  });

  it("routes a purpose-scoped block ticket only to its BlockDashboardAgent", async () => {
    const sessionId = "00000000-0000-7000-8000-000000000731";
    const userId = asUserId("00000000-0000-7000-8000-000000000732");
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000733");
    const workstreamId = "00000000-0000-7000-8000-000000000734";
    const blockId = "00000000-0000-7000-8000-000000000735";
    const initializeBlock = vi.fn(async () => undefined);
    const blockFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("x-rally-block-dashboard-block-id")).toBe(blockId);
      expect(request.headers.get("x-rally-session-id")).toBe(sessionId);
      expect(request.headers.get("sec-websocket-protocol")).toBeNull();
      return Response.json({ error: "socket_ticket_replayed" }, { status: 401 });
    });
    const env = createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      ALLOWED_ORIGINS: "app://avalon",
      SESSION_SIGNING_KEY: "socket-ticket-test-signing-key",
      BLOCK_DASHBOARD_AGENTS: createCloudflareTestBinding<Env["BLOCK_DASHBOARD_AGENTS"]>({
        idFromName: () => createTestDurableObjectId("block-dashboard-block-do-id"),
        get: () => ({ fetch: blockFetch, initializeBlock }),
      }),
    });
    const auth = { sessionId, userId, workspaceId, region: "global", role: "member" } as const;
    const ticket = await issueBlockDashboardBlockSocketTicket(env, auth, workstreamId, blockId);
    const request = new Request(
      `https://api.avalon.test/workstreams/${workstreamId}/block-dashboard/blocks/${blockId}`,
      {
        headers: {
          Origin: "app://avalon",
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": socketTicketProtocols(ticket).join(", "),
        },
      },
    );

    const response = await new BlockDashboardBlockSocketService(env).upgrade(
      workstreamId,
      blockId,
      undefined,
      request,
    );

    expect(response.status).toBe(401);
    expect(initializeBlock).toHaveBeenCalledWith({
      region: "global",
      workspaceId,
      workstreamId,
      blockId,
    });
    expect(blockFetch).toHaveBeenCalledOnce();
    await expect(verifyBlockDashboardBlockSocketTicket(env, ticket)).resolves.toMatchObject({
      workspaceId,
      workstreamId,
      blockId,
    });
    await expect(verifyWorkstreamControlSocketTicket(env, ticket))
      .rejects.toMatchObject({ code: "invalid_socket_ticket" });
  });

  it("reads the ticket from the handshake header a browser can actually set", () => {
    expect(socketTicketFromRequest(upgradeRequest(socketTicketProtocols(TICKET)), undefined)).toBe(TICKET);
  });

  it("still accepts the deprecated query ticket from a desktop build that predates the header", () => {
    expect(socketTicketFromRequest(upgradeRequest(), OLD_TICKET)).toBe(OLD_TICKET);
  });

  it("prefers the header so a client that moved over cannot be downgraded by its URL", () => {
    expect(socketTicketFromRequest(upgradeRequest(socketTicketProtocols(TICKET)), OLD_TICKET)).toBe(TICKET);
  });

  it("rejects a handshake that presents no ticket at all", () => {
    expect(() => socketTicketFromRequest(upgradeRequest(), undefined)).toThrow(ApiError);
    try {
      socketTicketFromRequest(upgradeRequest(["graphql-ws"]), undefined);
      expect.unreachable("a subprotocol offer without the sentinel is not a ticket");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("socket_ticket_required");
      expect((error as ApiError).status).toBe(401);
    }
  });

  it("answers the offer with the sentinel, never with the ticket", () => {
    // Chromium fails the handshake when the client offered subprotocols and the
    // server selected none, so the response has to name one — and echoing the
    // ticket would put the credential straight back into a header.
    vi.stubGlobal("Response", FakeResponse);
    const accepted = withNegotiatedSubprotocol(
      upgradeRequest(socketTicketProtocols(TICKET)),
      upgradeResponse(),
    );

    expect(accepted.status).toBe(101);
    expect(accepted.headers.get("sec-websocket-protocol")).toBe(SOCKET_TICKET_SUBPROTOCOL);
    expect(accepted.headers.get("sec-websocket-protocol")).not.toContain(TICKET);
  });

  it("refuses a malformed offer rather than falling back to the URL it distrusts", () => {
    // The client named the scheme, so its offer is the one that counts. Reading
    // the query here would let a stale URL credential stand in for the ticket
    // the client meant to present.
    expect(() => socketTicketFromRequest(upgradeRequest([SOCKET_TICKET_SUBPROTOCOL, "short"]), OLD_TICKET))
      .toThrow(ApiError);
  });

  it("leaves a room rejection alone rather than rebuilding it as an upgrade", () => {
    // A replayed ticket is refused by the room with a JSON 401. Negotiating a
    // subprotocol onto it would return a bodyless 101 carrying no socket, so
    // the case this path exists to refuse would arrive as a broken handshake.
    vi.stubGlobal("Response", FakeResponse);
    const rejection = new FakeResponse(JSON.stringify({ error: "socket_ticket_replayed" }), {
      status: 401,
    }) as unknown as Response;

    const answered = withNegotiatedSubprotocol(upgradeRequest(socketTicketProtocols(TICKET)), rejection);

    expect(answered).toBe(rejection);
    expect(answered.status).toBe(401);
    expect(answered.headers.get("sec-websocket-protocol")).toBeNull();
  });

  it("selects no subprotocol for a client that offered none", () => {
    vi.stubGlobal("Response", FakeResponse);
    const response = upgradeResponse();

    expect(withNegotiatedSubprotocol(upgradeRequest(), response)).toBe(response);
    expect(withNegotiatedSubprotocol(upgradeRequest(), response).headers.get("sec-websocket-protocol")).toBeNull();
  });
});
