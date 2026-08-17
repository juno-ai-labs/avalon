import { afterEach, describe, expect, it, vi } from "vitest";
import { socketTicketProtocols, SOCKET_TICKET_SUBPROTOCOL } from "@avalon/contracts/socket-tickets";
import { ApiError } from "../src/lib/api-error";
import {
  issueSocketTicket,
  SocketService,
  socketTicketFromRequest,
  withNegotiatedSubprotocol,
} from "../src/services/socket-service";
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
    const userId = "00000000-0000-7000-8000-000000000702";
    const workspaceId = "00000000-0000-7000-8000-000000000703";
    const workstreamId = "00000000-0000-7000-8000-000000000704";
    const roomFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("x-avalon-session-id")).toBe(sessionId);
      expect(request.headers.get("x-avalon-user-id")).toBe(userId);
      expect(request.headers.get("sec-websocket-protocol")).toBeNull();
      return Response.json({ error: "socket_ticket_replayed" }, { status: 401 });
    });
    const env = createTestEnv({
      APP_ENV: "test",
      AVALON_REGION: "global",
      ALLOWED_ORIGINS: "app://avalon",
      SESSION_SIGNING_KEY: "socket-ticket-test-signing-key",
      WORKSTREAM_ROOMS: createCloudflareTestBinding<DurableObjectNamespace>({
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

    const response = await new SocketService(env).upgrade(workstreamId, undefined, request);

    expect(response.status).toBe(401);
    expect(roomFetch).toHaveBeenCalledOnce();
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
