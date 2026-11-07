/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { socketTicketProtocols, SOCKET_TICKET_SUBPROTOCOL } from "@rally/contracts/socket-tickets";
import { roomUpgradeDiagnostics, withNegotiatedSubprotocol } from "../src/services/socket-service";

// Shaped like the compact JWS a ticket really is — dot-separated base64url —
// but without the `eyJ` header that makes a secret scanner read a fixture as a
// live token.
const TICKET = "dGlja2V0LWhlYWRlcg.dGlja2V0LXBheWxvYWQ.dGlja2V0LXNpZ25hdHVyZQ";

function handshake(): Request {
  return new Request("https://api.test/socket/workstreams/w1", {
    headers: {
      Origin: "app://avalon",
      Upgrade: "websocket",
      "sec-websocket-protocol": socketTicketProtocols(TICKET).join(", "),
    },
  });
}

/**
 * These run on real workerd rather than Node, because the constraint being
 * tested is a runtime one: a 101 is only constructible with a WebSocket
 * attached. The Node suite's stand-in `Response` validates no status, so it
 * would happily build the invalid upgrade this file exists to rule out.
 */
describe("subprotocol negotiation in workerd", () => {
  it("passes a room rejection through untouched rather than rebuilding it", () => {
    // `AgentLoopDO.connect` answers six paths with JSON and no socket —
    // 426, 400, 403, 401 on replay, 409, and 500. Rebuilding one as a 101
    // throws a RangeError that no branch in the error middleware matches, so a
    // deliberate rejection would surface as an unhandled 500.
    for (const status of [400, 401, 403, 409, 426, 500]) {
      const rejection = new Response(JSON.stringify({ error: "socket_ticket_replayed" }), { status });

      const answered = withNegotiatedSubprotocol(handshake(), rejection);

      expect(answered).toBe(rejection);
      expect(answered.status).toBe(status);
      expect(answered.headers.get("sec-websocket-protocol")).toBeNull();
    }
  });

  it("negotiates the sentinel onto a real upgrade", () => {
    const [client] = Object.values(new WebSocketPair());
    if (!client) throw new Error("WebSocketPair produced no client socket");
    const accepted = withNegotiatedSubprotocol(
      handshake(),
      new Response(null, { status: 101, webSocket: client }),
    );

    expect(accepted.status).toBe(101);
    expect(accepted.webSocket).toBe(client);
    expect(accepted.headers.get("sec-websocket-protocol")).toBe(SOCKET_TICKET_SUBPROTOCOL);
  });

  it.each([true, false])("strips diagnostics through the real handshake (subprotocol: %s)", (offerProtocol) => {
    for (const value of ["214", "0", "", "invalid", "3.5", "1".repeat(16), "1, 2"]) {
      const [client, server] = Object.values(new WebSocketPair());
      if (!client || !server) throw new Error("WebSocketPair is incomplete");
      server.accept();
      const request = handshake();
      if (!offerProtocol) request.headers.delete("sec-websocket-protocol");
      const diagnostic = roomUpgradeDiagnostics(new Response(null, {
        status: 101,
        webSocket: client,
        headers: {
          "x-rally-room-accept-ms": value,
          "x-avalon-room-accept-ms": value,
          "x-rally-room-instance-age-ms": value,
          "x-avalon-room-instance-age-ms": value,
          "x-test-preserved": "yes",
        },
      }), 500);
      const accepted = withNegotiatedSubprotocol(request, diagnostic.response);
      expect(accepted.status).toBe(101);
      expect(accepted.webSocket).toBe(client);
      expect(accepted.headers.get("x-test-preserved")).toBe("yes");
      expect([...accepted.headers.keys()].filter((name) => name.includes("room-"))).toEqual([]);
      expect(accepted.headers.get("sec-websocket-protocol"))
        .toBe(offerProtocol ? SOCKET_TICKET_SUBPROTOCOL : null);
      expect(diagnostic.attributes).toEqual(value === "214" || value === "0" ? {
        "rally.socket.room_accept_ms": Number(value),
        "rally.socket.room_outside_accept_ms": 500 - Number(value),
        "rally.socket.room_instance_age_ms": Number(value),
      } : {});
      client.accept();
      client.close(1000, "test complete");
      server.close(1000, "test complete");
    }
  });

  it("would throw if a rejection were rebuilt, which is why the guard exists", () => {
    // Pins the runtime constraint itself: if workerd ever allowed this, the
    // guard above could be relaxed, and if this starts passing the test that
    // matters has quietly stopped testing anything.
    expect(() => new Response(null, { status: 101 })).toThrow();
  });
});
