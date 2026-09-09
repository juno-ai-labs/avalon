import { socketUrlWithoutTicket } from "@rally/contracts/socket-tickets";
import { IdSchema, WORKSTREAM_REALTIME_MAX_FRAME_BYTES } from '@rally/contracts';
import { SOCKET_TICKET_SUBPROTOCOL } from '@rally/contracts/socket-tickets';
import { connect as netConnect, isIP, type NetConnectOpts, type Socket } from 'node:net';
import { connect as tlsConnect, getCACertificates } from 'node:tls';
import { ProxyAgent } from 'proxy-agent';
import { WebSocket } from 'ws';
import {
  RALLY_RENDERER_ORIGIN,
  type DesktopRealtimeSocketHandshakePhase,
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
  onHandshakePhase(listener: (phase: RealtimeSocketHandshakeTiming) => void): void;
  onMessage(listener: (data: unknown) => void): void;
  onOpen(listener: () => void): void;
  send(data: string): void;
  terminate(): void;
}

export interface RealtimeSocketHandshakeTiming {
  phase: DesktopRealtimeSocketHandshakePhase;
  durationMs: number;
  routeIndex: number;
  proxied: boolean;
}

export type RealtimeSocketFactory = (
  url: string,
  protocols: readonly string[],
  onHandshakePhase?: (phase: RealtimeSocketHandshakeTiming) => void,
) => RealtimeSocketClient;

export type RealtimeSocketProxyResolver = (url: string) => Promise<string>;

export function directSocketServername(url: string): string {
  // WHATWG URL keeps brackets around IPv6 literals, while `isIP` and TLS SNI
  // both require the bare address.
  const hostname = new URL(url).hostname.replace(/^\[|\]$/gu, '');
  return isIP(hostname) ? '' : hostname;
}

interface OwnedSocket {
  active: boolean;
  client: RealtimeSocketClient;
}

function wrapWebSocket(
  socket: WebSocket,
  onHandshakePhase: (listener: (phase: RealtimeSocketHandshakeTiming) => void) => void,
): RealtimeSocketClient {
  return {
    get extensions() { return socket.extensions; },
    get protocol() { return socket.protocol; },
    get readyState() { return socket.readyState; },
    close: (code, reason) => socket.close(code, reason),
    onClose: (listener) => socket.on('close', listener),
    onError: (listener) => socket.on('error', listener),
    onHandshakePhase,
    onMessage: (listener) => socket.on('message', (data) => listener(data)),
    onOpen: (listener) => socket.on('open', listener),
    send: (data) => socket.send(data),
    terminate: () => socket.terminate(),
  };
}

function proxyUrlFromElectronDirective(directive: string): string {
  if (!directive || directive.toUpperCase() === 'DIRECT') return '';
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

export function proxyUrlsFromElectronResolution(resolution: string): string[] {
  const directives = resolution.split(';').map((directive) => directive.trim()).filter(Boolean);
  return (directives.length === 0 ? ['DIRECT'] : directives).map(proxyUrlFromElectronDirective);
}

export interface RealtimeSocketAttemptInput {
  ca: readonly string[];
  maxPayload: number;
  protocols: readonly string[];
  proxyUrl: string;
  routeIndex: number;
  url: string;
  onHandshakePhase: (phase: RealtimeSocketHandshakeTiming) => void;
}

export type RealtimeSocketAttemptFactory = (
  input: RealtimeSocketAttemptInput,
) => RealtimeSocketClient;

function createNodeSocketAttempt(input: RealtimeSocketAttemptInput): RealtimeSocketClient {
  const startedAt = performance.now();
  let dnsAt: number | null = null;
  let tcpAt: number | null = null;
  let tlsAt: number | null = null;
  const secure = new URL(input.url).protocol === 'wss:';
  const phaseListeners = new Set<(phase: RealtimeSocketHandshakeTiming) => void>();
  const emit = (phase: DesktopRealtimeSocketHandshakePhase, durationMs: number): void => {
    const timing = {
      phase,
      durationMs: Math.max(0, Math.round(durationMs * 10) / 10),
      routeIndex: input.routeIndex,
      proxied: input.proxyUrl !== '',
    };
    input.onHandshakePhase(timing);
    for (const listener of phaseListeners) listener(timing);
  };
  const options = {
    maxPayload: input.maxPayload,
    origin: RALLY_RENDERER_ORIGIN,
    ca: [...input.ca],
  };
  // `ws` declares this hook with net.connect's overload even for `wss:`, but
  // its runtime passes the HTTPS/TLS options and expects a TLSSocket.
  function createDirectConnection(rawOptions: NetConnectOpts): Socket;
  function createDirectConnection(
    port: number,
    host?: string,
    connectionListener?: () => void,
  ): Socket;
  function createDirectConnection(path: string, connectionListener?: () => void): Socket;
  function createDirectConnection(
    rawOptions: NetConnectOpts | number | string,
    ...additionalArguments: Array<string | (() => void) | undefined>
  ): Socket {
    void additionalArguments;
    if (typeof rawOptions !== 'object') {
      throw new TypeError('The WebSocket TLS connector requires object connection options');
    }
    const connection = secure
      ? tlsConnect({
          ...rawOptions,
          path: undefined,
          servername: directSocketServername(input.url),
        })
      : netConnect(rawOptions);
    connection.once('lookup', () => {
      dnsAt = performance.now();
      emit('dns', dnsAt - startedAt);
    });
    connection.once('connect', () => {
      tcpAt = performance.now();
      emit('tcp', tcpAt - (dnsAt ?? startedAt));
    });
    if (secure) {
      connection.once('secureConnect', () => {
        tlsAt = performance.now();
        emit('tls', tlsAt - (tcpAt ?? dnsAt ?? startedAt));
      });
    }
    return connection;
  }
  const socket = input.proxyUrl === ''
    ? new WebSocket(input.url, [...input.protocols], {
        ...options,
        createConnection: createDirectConnection,
      })
    : new WebSocket(input.url, [...input.protocols], {
        ...options,
        agent: new ProxyAgent({
          ca: [...input.ca],
          getProxyForUrl: () => input.proxyUrl,
        }),
      });
  socket.once('upgrade', () => {
    if (input.proxyUrl === '') {
      emit('edge_upgrade', performance.now() - (tlsAt ?? tcpAt ?? dnsAt ?? startedAt));
    } else {
      emit('proxy_connect_tls_edge', performance.now() - startedAt);
    }
  });
  return wrapWebSocket(socket, (listener) => phaseListeners.add(listener));
}

/** One browser-shaped client that advances through Electron's PAC route. */
class ProxyFallbackRealtimeSocketClient implements RealtimeSocketClient {
  private readonly closeListeners = new Set<(code: number, reason: Uint8Array) => void>();
  private readonly errorListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(data: unknown) => void>();
  private readonly handshakePhaseListeners = new Set<
    (phase: RealtimeSocketHandshakeTiming) => void
  >();
  private readonly openListeners = new Set<() => void>();
  private current: RealtimeSocketClient | null = null;
  private generation = 0;
  private opened = false;
  private routes: string[] = [];
  private routeIndex = 0;
  private state: number = WebSocket.CONNECTING;
  private closeCode = 1_000;
  private closeReason = '';

  constructor(
    private readonly url: string,
    private readonly protocols: readonly string[],
    private readonly ca: readonly string[],
    resolveProxy: RealtimeSocketProxyResolver,
    private readonly createAttempt: RealtimeSocketAttemptFactory,
    onHandshakePhase?: (phase: RealtimeSocketHandshakeTiming) => void,
  ) {
    if (onHandshakePhase) this.handshakePhaseListeners.add(onHandshakePhase);
    const proxyStartedAt = performance.now();
    void resolveProxy(url)
      .then((resolution) => {
        this.emitHandshakePhase({
          phase: 'proxy_resolution',
          durationMs: Math.max(0, Math.round((performance.now() - proxyStartedAt) * 10) / 10),
          routeIndex: 0,
          proxied: resolution.trim().toUpperCase() !== 'DIRECT',
        });
        this.routes = proxyUrlsFromElectronResolution(resolution);
        this.openNext();
      })
      .catch(() => this.failFinal());
  }

  get extensions(): string { return this.current?.extensions ?? ''; }
  get protocol(): string { return this.current?.protocol ?? ''; }
  get readyState(): number { return this.state; }

  close(code = 1_000, reason = ''): void {
    if (this.state === WebSocket.CLOSING || this.state === WebSocket.CLOSED) return;
    this.state = WebSocket.CLOSING;
    this.closeCode = code;
    this.closeReason = reason;
    if (this.current) this.current.close(code, reason);
    else this.finishClose(code, Buffer.from(reason));
  }

  onClose(listener: (code: number, reason: Uint8Array) => void): void { this.closeListeners.add(listener); }
  onError(listener: () => void): void { this.errorListeners.add(listener); }
  onHandshakePhase(listener: (phase: RealtimeSocketHandshakeTiming) => void): void {
    this.handshakePhaseListeners.add(listener);
  }
  onMessage(listener: (data: unknown) => void): void { this.messageListeners.add(listener); }
  onOpen(listener: () => void): void { this.openListeners.add(listener); }

  send(data: string): void {
    if (this.state !== WebSocket.OPEN || !this.current) throw new Error('Realtime socket is not open');
    this.current.send(data);
  }

  terminate(): void {
    if (this.state === WebSocket.CLOSED) return;
    this.state = WebSocket.CLOSED;
    this.generation += 1;
    this.current?.terminate();
    this.current = null;
  }

  private openNext(): void {
    if (this.state === WebSocket.CLOSED) return;
    if (this.state === WebSocket.CLOSING) {
      this.finishClose(this.closeCode, Buffer.from(this.closeReason));
      return;
    }
    const routeIndex = this.routeIndex++;
    const proxyUrl = this.routes[routeIndex];
    if (proxyUrl === undefined) {
      this.failFinal();
      return;
    }
    const generation = this.generation += 1;
    const routeStartedAt = performance.now();
    let attempt: RealtimeSocketClient;
    try {
      attempt = this.createAttempt({
        ca: this.ca,
        maxPayload: WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
        protocols: this.protocols,
        proxyUrl,
        routeIndex,
        url: this.url,
        onHandshakePhase: (phase) => this.emitHandshakePhase(phase),
      });
    } catch {
      this.emitRouteFailure(routeIndex, proxyUrl, routeStartedAt);
      this.openNext();
      return;
    }
    this.current = attempt;
    attempt.onOpen(() => {
      if (!this.isCurrent(generation, attempt)) return;
      this.opened = true;
      this.state = WebSocket.OPEN;
      for (const listener of this.openListeners) listener();
    });
    attempt.onMessage((data) => {
      if (!this.opened || !this.isCurrent(generation, attempt)) return;
      for (const listener of this.messageListeners) listener(data);
    });
    attempt.onError(() => {
      if (!this.isCurrent(generation, attempt)) return;
      if (this.opened) {
        for (const listener of this.errorListeners) listener();
        return;
      }
      this.failAttempt(attempt, routeIndex, proxyUrl, routeStartedAt);
    });
    attempt.onClose((code, reason) => {
      if (!this.isCurrent(generation, attempt)) return;
      if (this.opened || this.state === WebSocket.CLOSING) {
        this.finishClose(code, reason);
        return;
      }
      this.failAttempt(attempt, routeIndex, proxyUrl, routeStartedAt);
    });
  }

  private isCurrent(generation: number, attempt: RealtimeSocketClient): boolean {
    return this.generation === generation && this.current === attempt;
  }

  private failAttempt(
    attempt: RealtimeSocketClient,
    routeIndex: number,
    proxyUrl: string,
    routeStartedAt: number,
  ): void {
    this.emitRouteFailure(routeIndex, proxyUrl, routeStartedAt);
    this.generation += 1;
    this.current = null;
    attempt.terminate();
    this.openNext();
  }

  private emitRouteFailure(routeIndex: number, proxyUrl: string, startedAt: number): void {
    this.emitHandshakePhase({
      phase: 'route_failed',
      durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10),
      routeIndex,
      proxied: proxyUrl !== '',
    });
  }

  private emitHandshakePhase(phase: RealtimeSocketHandshakeTiming): void {
    for (const listener of this.handshakePhaseListeners) listener(phase);
  }

  private failFinal(): void {
    if (this.state === WebSocket.CLOSED) return;
    for (const listener of this.errorListeners) listener();
    this.finishClose(1_006, new Uint8Array());
  }

  private finishClose(code: number, reason: Uint8Array): void {
    if (this.state === WebSocket.CLOSED) return;
    this.state = WebSocket.CLOSED;
    this.generation += 1;
    this.current = null;
    for (const listener of this.closeListeners) listener(code, reason);
  }
}

/**
 * Keep Node-owned sockets independent of Chromium's per-renderer connection
 * scheduling while preserving the operating system proxy and trust settings
 * that Electron uses for the rest of the application.
 */
export function createNodeRealtimeSocketFactory(
  resolveProxy: RealtimeSocketProxyResolver,
  createAttempt: RealtimeSocketAttemptFactory = createNodeSocketAttempt,
): RealtimeSocketFactory {
  const ca = [...new Set([
    ...getCACertificates('default'),
    ...getCACertificates('system'),
  ])];
  return (url, protocols, onHandshakePhase) => new ProxyFallbackRealtimeSocketClient(
    url,
    protocols,
    ca,
    resolveProxy,
    createAttempt,
    onHandshakePhase,
  );
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
  if (segments[0] !== 'socket') return false;
  if (input.kind === 'workstream_control') {
    return segments.length === 3
      && segments[1] === 'workstreams'
      && IdSchema.safeParse(segments[2]).success;
  }
  // A feed is addressed by its conversation, whichever kind of parent it has:
  // a work stream's and an automation's feeds share one upgrade route.
  return segments.length === 4
    && segments[1] === 'conversations'
    && IdSchema.safeParse(segments[2]).success
    && (segments[3] === '0' || IdSchema.safeParse(segments[3]).success);
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
  if (url.username || url.password || url.hash) return false;
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

  constructor(private readonly createSocket: RealtimeSocketFactory) {}

  open(
    ownerId: number,
    input: DesktopRealtimeSocketOpenInput,
    emit: (event: DesktopRealtimeSocketEvent) => void,
  ): void {
    const key = this.key(ownerId, input.socketId);
    if (this.sockets.has(key)) throw new Error('Realtime socket ID is already in use');
    const pendingHandshakePhases: RealtimeSocketHandshakeTiming[] = [];
    let relayHandshakePhase = (phase: RealtimeSocketHandshakeTiming): void => {
      pendingHandshakePhases.push(phase);
    };
    const owned: OwnedSocket = {
      active: true,
      client: this.createSocket(socketUrlWithoutTicket(input.url), input.protocols, (phase) => relayHandshakePhase(phase)),
    };
    this.sockets.set(key, owned);
    const emitWhileOwned = (event: DesktopRealtimeSocketEvent): void => {
      if (owned.active && this.sockets.get(key) === owned) emit(event);
    };
    relayHandshakePhase = (phase): void => emitWhileOwned({
      type: 'handshake_phase',
      socketId: input.socketId,
      ...phase,
    });
    for (const phase of pendingHandshakePhases.splice(0)) relayHandshakePhase(phase);
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
