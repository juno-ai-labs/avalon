import { asUserId, asWorkspaceId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { socketTicketProtocols, SOCKET_TICKET_SUBPROTOCOL } from "@rally/contracts/socket-tickets";
import { ApiError } from "../src/lib/api-error";
import {
  issueSocketTicket,
  issueWorkstreamControlSocketTicket,
  issueWorkspaceSocketTicket,
  SocketService,
  socketTicketFromRequest,
  verifySocketTicket,
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
      expect(request.headers.get("x-rally-socket-after-sequence")).toBe("42");
      expect(request.headers.get("x-avalon-socket-after-sequence")).toBeNull();
      expect(request.headers.get("x-rally-socket-speculative")).toBe("true");
      expect(request.headers.get("x-avalon-socket-speculative")).toBeNull();
      expect(request.headers.get("x-rally-socket-admission-version")).toBe("1");
      expect(request.headers.get("x-rally-socket-admission-authority-generation")).toBe("7");
      expect(request.headers.get("x-rally-socket-admission-role")).toBe("member");
      expect(request.headers.get("x-rally-socket-analytics-workspace-id")).toBe("analytics-workspace");
      expect(request.headers.get("x-avalon-socket-admission-role")).toBeNull();
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
    }, { kind: "workstream", id: workstreamId }, "0", undefined, 42, true, {
      admission: {
        authorityGeneration: 7,
        role: "member",
        analyticsWorkspaceId: "analytics-workspace",
        parentArchived: false,
      },
    });
    const request = new Request(`https://api.avalon.test/workstreams/${workstreamId}/socket`, {
      headers: {
        Origin: "app://avalon",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": socketTicketProtocols(ticket).join(", "),
        "x-rally-socket-after-sequence": "999",
        "x-avalon-socket-after-sequence": "998",
        "x-rally-socket-speculative": "false",
        "x-avalon-socket-speculative": "true",
        "x-rally-socket-admission-version": "999",
        "x-rally-socket-admission-authority-generation": "999",
        "x-rally-socket-admission-role": "owner",
        "x-rally-socket-analytics-workspace-id": "forged",
        "x-avalon-socket-admission-role": "admin",
      },
    });

    const response = await new SocketService(env).upgrade(workstreamId, "0", undefined, request);

    expect(response.status).toBe(401);
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it("strips unsigned cursor and speculative headers when the ticket has no claims", async () => {
    const sessionId = "00000000-0000-7000-8000-000000000741";
    const userId = asUserId("00000000-0000-7000-8000-000000000742");
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000743");
    const workstreamId = "00000000-0000-7000-8000-000000000744";
    const roomFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("x-rally-socket-after-sequence")).toBeNull();
      expect(request.headers.get("x-avalon-socket-after-sequence")).toBeNull();
      expect(request.headers.get("x-rally-socket-speculative")).toBeNull();
      expect(request.headers.get("x-avalon-socket-speculative")).toBeNull();
      expect(request.headers.get("x-rally-socket-admission-version")).toBeNull();
      expect(request.headers.get("x-rally-socket-admission-authority-generation")).toBeNull();
      expect(request.headers.get("x-rally-socket-admission-role")).toBeNull();
      expect(request.headers.get("x-rally-socket-analytics-workspace-id")).toBeNull();
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
    }, { kind: "workstream", id: workstreamId });
    const request = new Request(`https://api.avalon.test/workstreams/${workstreamId}/socket`, {
      headers: {
        Origin: "app://avalon",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": socketTicketProtocols(ticket).join(", "),
        "x-rally-socket-after-sequence": "999",
        "x-avalon-socket-after-sequence": "998",
        "x-rally-socket-speculative": "true",
        "x-avalon-socket-speculative": "true",
        "x-rally-socket-admission-version": "1",
        "x-rally-socket-admission-authority-generation": "7",
        "x-rally-socket-admission-role": "owner",
        "x-rally-socket-analytics-workspace-id": "forged",
      },
    });

    const response = await new SocketService(env).upgrade(workstreamId, "0", undefined, request);

    expect(response.status).toBe(401);
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it.each(["connector", "demo_seed"] as const)("refuses to mint any socket ticket for a %s principal", async (principal) => {
    // A socket ticket is a session credential: admission stores its `sid`, and
    // the access-revocation queue closes sockets by matching that id against
    // real `sessions` rows. A non-session principal's correlation id matches
    // no session, so a ticket minted from one would open a read feed that no
    // session revocation could ever close. The documented invariant — sockets
    // never carry a non-session principal — is enforced at the mint, and this
    // is the assertion behind it, for each principal the product has.
    const env = createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      SESSION_SIGNING_KEY: "socket-ticket-test-signing-key",
    });
    const auth = {
      sessionId: principal === "connector" ? "slack:T123:U456" : "demo-seed:op:action",
      userId: asUserId("00000000-0000-7000-8000-000000000722"),
      workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000723"),
      region: "global" as const,
      role: "member" as const,
      principal,
    };
    const refusal = { status: 403, code: "non_session_principal_cannot_hold_socket" };

    await expect(issueSocketTicket(env, auth, { kind: "workstream", id: "00000000-0000-7000-8000-000000000724" }))
      .rejects.toMatchObject(refusal);
    await expect(issueWorkspaceSocketTicket(env, auth)).rejects.toMatchObject(refusal);
    await expect(issueWorkstreamControlSocketTicket(env, auth, "00000000-0000-7000-8000-000000000724"))
      .rejects.toMatchObject(refusal);
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

  it.each([false, true])("routes a separately scoped metadata ticket to WorkstreamDO (appearance support: %s)", async (supportsAppearance) => {
    const sessionId = "00000000-0000-7000-8000-000000000721";
    const userId = asUserId("00000000-0000-7000-8000-000000000722");
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000723");
    const workstreamId = "00000000-0000-7000-8000-000000000724";
    const workstreamFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).searchParams.get("workstreamAppearance")).toBe(supportsAppearance ? "1" : null);
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
    const request = new Request(`https://api.avalon.test/workstreams/${workstreamId}${supportsAppearance ? "?workstreamAppearance=1" : ""}`, {
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
