import { IdSchema } from '@rally/contracts';
import { SOCKET_TICKET_SUBPROTOCOL } from '@rally/contracts/socket-tickets';
import { getCACertificates } from 'node:tls';
import { ProxyAgent } from 'proxy-agent';
import { WebSocket } from 'ws';
import {
  RALLY_RENDERER_ORIGIN,
  type DesktopRealtimeSocketEvent,
  type DesktopRealtimeSocketOpenInput,
} from '../common/realtime-socket';

export interface RealtimeSocketClient {
  readonly extensions: string;
  readonly protocol: string;
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  onClose(listener: (code: number, reason: Uint8Array) => void): void;
  onError(listener: () => void): void;
  onMessage(listener: (data: unknown) => void): void;
  onOpen(listener: () => void): void;
  send(data: string): void;
  terminate(): void;
}

export type RealtimeSocketFactory = (
  url: string,
  protocols: readonly string[],
) => RealtimeSocketClient;

export type RealtimeSocketProxyResolver = (url: string) => Promise<string>;

interface OwnedSocket {
  active: boolean;
  client: RealtimeSocketClient;
}

function wrapWebSocket(socket: WebSocket): RealtimeSocketClient {
  return {
    get extensions() { return socket.extensions; },
    get protocol() { return socket.protocol; },
    get readyState() { return socket.readyState; },
    close: (code, reason) => socket.close(code, reason),
    onClose: (listener) => socket.on('close', listener),
    onError: (listener) => socket.on('error', listener),
    onMessage: (listener) => socket.on('message', (data) => listener(data)),
    onOpen: (listener) => socket.on('open', listener),
    send: (data) => socket.send(data),
    terminate: () => socket.terminate(),
  };
}

function defaultSocketFactory(url: string, protocols: readonly string[]): RealtimeSocketClient {
  return wrapWebSocket(new WebSocket(url, [...protocols], { origin: RALLY_RENDERER_ORIGIN }));
}

export function proxyUrlFromElectronResolution(resolution: string): string {
  const directive = resolution.split(';', 1)[0]?.trim() ?? '';
  if (!directive || directive === 'DIRECT') return '';
  const separator = directive.indexOf(' ');
  if (separator < 1) throw new Error('Electron returned an invalid proxy directive');
  const kind = directive.slice(0, separator).toUpperCase();
  const address = directive.slice(separator + 1).trim();
  if (!address) throw new Error('Electron returned an invalid proxy directive');
  switch (kind) {
    case 'PROXY': return `http://${address}`;
    case 'HTTPS': return `https://${address}`;
    case 'SOCKS':
    case 'SOCKS5': return `socks5://${address}`;
    case 'SOCKS4': return `socks4://${address}`;
    default: throw new Error('Electron returned an unsupported proxy directive');
  }
}

/**
 * Keep Node-owned sockets independent of Chromium's per-renderer connection
 * scheduling while preserving the operating system proxy and trust settings
 * that Electron uses for the rest of the application.
 */
export function createNodeRealtimeSocketFactory(
  resolveProxy: RealtimeSocketProxyResolver,
): RealtimeSocketFactory {
  const ca = [...new Set([
    ...getCACertificates('default'),
    ...getCACertificates('system'),
  ])];
  const agent = new ProxyAgent({
    ca,
    getProxyForUrl: async (url) => proxyUrlFromElectronResolution(await resolveProxy(url)),
  });
  return (url, protocols) => wrapWebSocket(new WebSocket(url, [...protocols], {
    agent,
    origin: RALLY_RENDERER_ORIGIN,
  }));
}

function socketOrigin(apiBaseUrl: string): string | null {
  try {
    const url = new URL(apiBaseUrl);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    else return null;
    return url.origin;
  } catch {
    return null;
  }
}

function validSocketPath(input: DesktopRealtimeSocketOpenInput, url: URL): boolean {
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return false;
  }
  if (segments[0] !== 'socket' || segments[1] !== 'workstreams') return false;
  if (!IdSchema.safeParse(segments[2]).success) return false;
  if (input.kind === 'workstream_control') return segments.length === 3;
  return segments.length === 5
    && segments[3] === 'substreams'
    && (segments[4] === '0' || IdSchema.safeParse(segments[4]).success);
}

/**
 * Keep the renderer bridge from becoming an arbitrary network primitive. The
 * renderer may dial only Rally's configured regional work-stream endpoints;
 * main supplies the privileged Origin header and never accepts one over IPC.
 * Protocols cross IPC only because the first entry is constrained to Rally's
 * ticket protocol and the remaining entry is the short-lived ticket.
 */
export function realtimeSocketTargetAllowed(
  input: DesktopRealtimeSocketOpenInput,
  apiBaseUrls: readonly string[],
): boolean {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (!apiBaseUrls.map(socketOrigin).includes(url.origin)) return false;
  if (input.protocols[0] !== SOCKET_TICKET_SUBPROTOCOL) return false;
  return validSocketPath(input, url);
}

function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return String(data);
}

export class RealtimeSocketBroker {
  private readonly sockets = new Map<string, OwnedSocket>();

  constructor(private readonly createSocket: RealtimeSocketFactory = defaultSocketFactory) {}

  open(
    ownerId: number,
    input: DesktopRealtimeSocketOpenInput,
    emit: (event: DesktopRealtimeSocketEvent) => void,
  ): void {
    const key = this.key(ownerId, input.socketId);
    if (this.sockets.has(key)) throw new Error('Realtime socket ID is already in use');
    const owned: OwnedSocket = {
      active: true,
      client: this.createSocket(input.url, input.protocols),
    };
    this.sockets.set(key, owned);
    const emitWhileOwned = (event: DesktopRealtimeSocketEvent): void => {
      if (owned.active && this.sockets.get(key) === owned) emit(event);
    };
    owned.client.onOpen(() => emitWhileOwned({
      type: 'open',
      socketId: input.socketId,
      protocol: owned.client.protocol,
      extensions: owned.client.extensions,
    }));
    owned.client.onMessage((data) => emitWhileOwned({
      type: 'message',
      socketId: input.socketId,
      data: messageText(data),
    }));
    owned.client.onError(() => emitWhileOwned({
      type: 'error',
      socketId: input.socketId,
    }));
    owned.client.onClose((code, reason) => {
      emitWhileOwned({
        type: 'close',
        socketId: input.socketId,
        code,
        reason: Buffer.from(reason).toString('utf8'),
        // ws exposes the peer close code but not the browser's internal clean-
        // shutdown bit. An abnormal-closure sentinel is the closest public
        // equivalent and is sufficient for the renderer's reconnect policy.
        wasClean: code !== 1006,
      });
      owned.active = false;
      if (this.sockets.get(key) === owned) this.sockets.delete(key);
    });
  }

  send(ownerId: number, socketId: string, data: string): void {
    const owned = this.sockets.get(this.key(ownerId, socketId));
    if (!owned || owned.client.readyState !== WebSocket.OPEN) {
      throw new Error('Realtime socket is not open');
    }
    owned.client.send(data);
  }

  close(ownerId: number, socketId: string, code?: number, reason?: string): void {
    const owned = this.sockets.get(this.key(ownerId, socketId));
    if (!owned) return;
    if (owned.client.readyState === WebSocket.CLOSING || owned.client.readyState === WebSocket.CLOSED) return;
    try {
      owned.client.close(code, reason);
    } catch (error) {
      owned.active = false;
      this.sockets.delete(this.key(ownerId, socketId));
      owned.client.terminate();
      throw error;
    }
  }

  closeOwner(ownerId: number): void {
    const prefix = `${ownerId}:`;
    for (const [key, owned] of this.sockets) {
      if (!key.startsWith(prefix)) continue;
      owned.active = false;
      this.sockets.delete(key);
      owned.client.terminate();
    }
  }

  private key(ownerId: number, socketId: string): string {
    return `${ownerId}:${socketId}`;
  }
}
