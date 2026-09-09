import { describe, expect, it } from "vitest";
import {
  offersSocketTicketSubprotocol,
  socketTicketFromProtocols,
  socketTicketProtocols,
  socketUrlWithoutTicket,
  SOCKET_TICKET_SUBPROTOCOL,
} from "./socket-tickets";

// Shaped like the compact JWS a ticket really is — dot-separated base64url —
// but without the `eyJ` header that makes a secret scanner read a fixture as a
// live token. Nothing under test parses the structure: the transport only cares
// that the token is in the character class and length a subprotocol allows.
const TICKET = "dGlja2V0LWhlYWRlcg.dGlja2V0LXBheWxvYWQ.dGlja2V0LXNpZ25hdHVyZQ";

describe("socket ticket subprotocols", () => {
  it("offers the sentinel first so the server can echo a name that is not the credential", () => {
    expect(socketTicketProtocols(TICKET)).toEqual([SOCKET_TICKET_SUBPROTOCOL, TICKET]);
  });

  it("reads the ticket back out of the header the browser sends", () => {
    const header = socketTicketProtocols(TICKET).join(", ");

    expect(offersSocketTicketSubprotocol(header)).toBe(true);
    expect(socketTicketFromProtocols(header)).toBe(TICKET);
  });

  it("ignores a subprotocol offer that does not name this scheme", () => {
    // Without the sentinel there is no claim that the second token is a ticket,
    // so nothing is read out of it.
    expect(socketTicketFromProtocols(`graphql-ws, ${TICKET}`)).toBeNull();
    expect(offersSocketTicketSubprotocol("graphql-ws")).toBe(false);
    expect(socketTicketFromProtocols(null)).toBeNull();
    expect(socketTicketFromProtocols(SOCKET_TICKET_SUBPROTOCOL)).toBeNull();
  });

  it("refuses a token that cannot be a ticket rather than passing it to the verifier", () => {
    expect(socketTicketFromProtocols(`${SOCKET_TICKET_SUBPROTOCOL}, short`)).toBeNull();
    expect(socketTicketFromProtocols(`${SOCKET_TICKET_SUBPROTOCOL}, ${"a".repeat(4_001)}`)).toBeNull();
  });

  it("strips all query configuration and deprecated tickets", () => {
    expect(socketUrlWithoutTicket(`wss://api.with-avalon.com/socket/workstreams/w1?ticket=${TICKET}`))
      .toBe("wss://api.with-avalon.com/socket/workstreams/w1");
    expect(socketUrlWithoutTicket(`wss://api.with-avalon.com/socket/transcription?ticket=${TICKET}&trace=1`))
      .toBe("wss://api.with-avalon.com/socket/transcription");
    expect(socketUrlWithoutTicket("wss://api.with-avalon.com/socket/workstreams/w1"))
      .toBe("wss://api.with-avalon.com/socket/workstreams/w1");
  });
});
