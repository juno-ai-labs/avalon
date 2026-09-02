import type {
  DesktopRealtimeSocketEvent,
  DesktopRealtimeSocketHandshakePhase,
} from './realtime-socket';

export const REALTIME_SOCKET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const REALTIME_SOCKET_IPC_CHANNELS = {
  close: 'realtime-socket:close',
  event: 'realtime-socket:event',
  open: 'realtime-socket:open',
  send: 'realtime-socket:send',
} as const;

export const MAX_WEBSOCKET_CLOSE_REASON_BYTES = 123;

const REALTIME_SOCKET_HANDSHAKE_PHASES = new Set<DesktopRealtimeSocketHandshakePhase>([
  'proxy_resolution',
  'dns',
  'tcp',
  'tls',
  'edge_upgrade',
  'proxy_connect_tls_edge',
  'route_failed',
]);

/** The application-supplied close codes accepted by WHATWG WebSocket. */
export function validWebSocketCloseCode(code: number): boolean {
  return code === 1_000 || (code >= 3_000 && code <= 4_999);
}

export function validWebSocketCloseReason(reason: string): boolean {
  return new TextEncoder().encode(reason).byteLength <= MAX_WEBSOCKET_CLOSE_REASON_BYTES;
}

/** Dependency-free validation for the sandboxed CommonJS preload bundle. */
export function parseRealtimeSocketEvent(rawEvent: unknown): DesktopRealtimeSocketEvent | null {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  const event = rawEvent as Record<string, unknown>;
  if (typeof event['socketId'] !== 'string'
    || !REALTIME_SOCKET_ID_PATTERN.test(event['socketId'])) return null;
  const hasOnlyKeys = (...keys: string[]): boolean => {
    const expected = new Set(keys);
    return Object.keys(event).every((key) => expected.has(key))
      && keys.every((key) => Object.hasOwn(event, key));
  };
  const phase = event['phase'];
  if (event['type'] === 'handshake_phase'
    && hasOnlyKeys('type', 'socketId', 'phase', 'durationMs', 'routeIndex', 'proxied')
    && typeof phase === 'string'
    && REALTIME_SOCKET_HANDSHAKE_PHASES.has(phase as DesktopRealtimeSocketHandshakePhase)
    && typeof event['durationMs'] === 'number'
    && Number.isFinite(event['durationMs'])
    && event['durationMs'] >= 0
    && typeof event['routeIndex'] === 'number'
    && Number.isInteger(event['routeIndex'])
    && event['routeIndex'] >= 0
    && typeof event['proxied'] === 'boolean') {
    return {
      type: 'handshake_phase', socketId: event['socketId'],
      phase: phase as DesktopRealtimeSocketHandshakePhase,
      durationMs: event['durationMs'], routeIndex: event['routeIndex'], proxied: event['proxied'],
    };
  }
  if (event['type'] === 'open'
    && hasOnlyKeys('type', 'socketId', 'protocol', 'extensions')
    && typeof event['protocol'] === 'string'
    && typeof event['extensions'] === 'string') {
    return {
      type: 'open', socketId: event['socketId'],
      protocol: event['protocol'], extensions: event['extensions'],
    };
  }
  if (event['type'] === 'message'
    && hasOnlyKeys('type', 'socketId', 'data')
    && typeof event['data'] === 'string') {
    return { type: 'message', socketId: event['socketId'], data: event['data'] };
  }
  if (event['type'] === 'error' && hasOnlyKeys('type', 'socketId')) {
    return { type: 'error', socketId: event['socketId'] };
  }
  if (event['type'] === 'close'
    && hasOnlyKeys('type', 'socketId', 'code', 'reason', 'wasClean')
    && typeof event['code'] === 'number'
    && Number.isInteger(event['code'])
    && typeof event['reason'] === 'string'
    && typeof event['wasClean'] === 'boolean') {
    return {
      type: 'close', socketId: event['socketId'], code: event['code'],
      reason: event['reason'], wasClean: event['wasClean'],
    };
  }
  return null;
}
