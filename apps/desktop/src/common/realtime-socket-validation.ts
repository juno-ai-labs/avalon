export const REALTIME_SOCKET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const MAX_WEBSOCKET_CLOSE_REASON_BYTES = 123;

/** The application-supplied close codes accepted by WHATWG WebSocket. */
export function validWebSocketCloseCode(code: number): boolean {
  return code === 1_000 || (code >= 3_000 && code <= 4_999);
}

export function validWebSocketCloseReason(reason: string): boolean {
  return new TextEncoder().encode(reason).byteLength <= MAX_WEBSOCKET_CLOSE_REASON_BYTES;
}
