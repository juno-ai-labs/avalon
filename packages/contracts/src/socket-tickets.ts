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
export const SOCKET_TICKET_SUBPROTOCOL = "rally.ticket.v1";

/**
 * Sentinels still honoured inbound, and deliberately never offered.
 *
 * The rename from Avalon to Rally moved the sentinel, but a desktop build
 * already installed keeps offering the one it shipped with. Accepting the
 * superseded spelling is not enough on its own: Chromium fails a handshake
 * whose response selects a subprotocol the client never offered, so the server
 * has to echo back the one it was actually given — which is what
 * `negotiatedSocketTicketSubprotocol` is for. Retiring one is an edit to this
 * list once those builds are gone.
 */
export const SUPERSEDED_SOCKET_TICKET_SUBPROTOCOLS: readonly string[] = Object.freeze([
  "avalon.ticket.v1",
]);

const TICKET_SENTINELS: readonly string[] = Object.freeze([
  SOCKET_TICKET_SUBPROTOCOL,
  ...SUPERSEDED_SOCKET_TICKET_SUBPROTOCOLS,
]);

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
  return negotiatedSocketTicketSubprotocol(header) !== null;
}

/**
 * The sentinel the client actually offered — canonical or superseded — or null
 * when it offered none. This is the one a 101 must echo: selecting a spelling
 * the client never sent fails the handshake exactly as selecting none does.
 */
export function negotiatedSocketTicketSubprotocol(header: string | null | undefined): string | null {
  const tokens = protocolTokens(header);
  return TICKET_SENTINELS.find((sentinel) => tokens.includes(sentinel)) ?? null;
}

/**
 * The ticket the client offered alongside the sentinel, or null when it offered
 * none. Only a sentinel identifies the scheme, so a client that offers some
 * other subprotocol gets no ticket read out of it.
 */
export function socketTicketFromProtocols(header: string | null | undefined): string | null {
  const tokens = protocolTokens(header);
  if (!tokens.some((token) => TICKET_SENTINELS.includes(token))) return null;
  return tokens.find((token) => !TICKET_SENTINELS.includes(token) && TICKET_TOKEN.test(token)) ?? null;
}

/**
 * Strip all query data from a URL an issuing endpoint returned.
 * Socket protocols are unconditional; older ticket and capability parameters
 * must neither block a connection nor configure one.
 *
 * Total by design: this runs inside a schema transform, and throwing there
 * would surface a bare `TypeError` instead of the parse failure the caller
 * handles. A URL that cannot be parsed is returned unchanged, so it fails where
 * it did before — at the `WebSocket` constructor.
 */
export function socketUrlWithoutTicket(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.search = "";
  return parsed.toString();
}

function protocolTokens(header: string | null | undefined): string[] {
  if (!header) return [];
  return header.split(",").map((token) => token.trim()).filter(Boolean);
}
