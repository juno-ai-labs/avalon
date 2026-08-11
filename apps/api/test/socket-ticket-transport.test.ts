import { afterEach, describe, expect, it, vi } from "vitest";
import { socketTicketProtocols, SOCKET_TICKET_SUBPROTOCOL } from "@avalon/contracts/socket-tickets";
import { ApiError } from "../src/lib/api-error";
import { socketTicketFromRequest, withNegotiatedSubprotocol } from "../src/services/socket-service";

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
  return new FakeResponse(null, { status: 101 }) as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

function upgradeRequest(protocols?: string[]): Request {
  const headers = new Headers({ Origin: "app://avalon", Upgrade: "websocket" });
  if (protocols) headers.set("sec-websocket-protocol", protocols.join(", "));
  return { headers } as Request;
}

describe("socket ticket transport", () => {
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

  it("selects no subprotocol for a client that offered none", () => {
    vi.stubGlobal("Response", FakeResponse);
    const response = upgradeResponse();

    expect(withNegotiatedSubprotocol(upgradeRequest(), response)).toBe(response);
    expect(withNegotiatedSubprotocol(upgradeRequest(), response).headers.get("sec-websocket-protocol")).toBeNull();
  });
});
