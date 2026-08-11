/**
 * How a realtime ticket reaches the Worker that verifies it.
 *
 * A browser cannot set headers on a WebSocket handshake, so a bearer credential
 * has nowhere obvious to ride and the query string is the usual answer. It is
 * the wrong one here: Cloudflare records the whole request URL independently of
 * what Avalon logs — the invocation log's `$workers.event.request.url`, the
 * Logpush export's `Event` field, and a trace span's `url.query` — so a ticket
 * in the query lands in three stores that no redaction in this repository can
 * reach.
 *
 * `Sec-WebSocket-Protocol` is the one request header a browser will set, via
 * the `protocols` argument of the `WebSocket` constructor. The client offers two
 * tokens: a sentinel naming this scheme, and the ticket itself. Cloudflare does
 * not capture the header, so the credential stays out of the URL entirely.
 */
export const SOCKET_TICKET_SUBPROTOCOL = "avalon.ticket.v1";

/**
 * The deprecated query parameter, still accepted so a desktop build released
 * before this scheme keeps connecting. Remove it once those builds are gone.
 */
export const SOCKET_TICKET_QUERY_PARAM = "ticket";

/**
 * A ticket is a compact JWS: base64url segments joined by dots, which is a
 * subset of an HTTP token and therefore a legal subprotocol name. Anything else
 * is not a ticket this scheme produced, and is refused rather than forwarded to
 * a verifier that would only reject it later.
 */
const TICKET_TOKEN = /^[A-Za-z0-9._~+/-]{20,4000}=*$/u;

export function socketTicketProtocols(ticket: string): [string, string] {
  return [SOCKET_TICKET_SUBPROTOCOL, ticket];
}

export function offersSocketTicketSubprotocol(header: string | null | undefined): boolean {
  return protocolTokens(header).includes(SOCKET_TICKET_SUBPROTOCOL);
}

/**
 * The ticket the client offered alongside the sentinel, or null when it offered
 * none. Only the sentinel identifies the scheme, so a client that offers some
 * other subprotocol gets no ticket read out of it.
 */
export function socketTicketFromProtocols(header: string | null | undefined): string | null {
  const tokens = protocolTokens(header);
  if (!tokens.includes(SOCKET_TICKET_SUBPROTOCOL)) return null;
  return tokens.find((token) => token !== SOCKET_TICKET_SUBPROTOCOL && TICKET_TOKEN.test(token)) ?? null;
}

/** Strip the deprecated query ticket from a URL an issuing endpoint returned. */
export function socketUrlWithoutTicket(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete(SOCKET_TICKET_QUERY_PARAM);
  return parsed.toString();
}

function protocolTokens(header: string | null | undefined): string[] {
  if (!header) return [];
  return header.split(",").map((token) => token.trim()).filter(Boolean);
}
