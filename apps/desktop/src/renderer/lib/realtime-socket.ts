import type {
  DesktopRealtimeSocketCloseInput,
  DesktopRealtimeSocketEvent,
  DesktopRealtimeSocketHandshakePhase,
  DesktopRealtimeSocketKind,
  DesktopRealtimeSocketOpenInput,
  DesktopRealtimeSocketSendInput,
} from '../../common/realtime-socket';
import {
  MAX_WEBSOCKET_CLOSE_REASON_BYTES,
  validWebSocketCloseCode,
  validWebSocketCloseReason,
} from '../../common/realtime-socket-validation';
import { desktopBridge, desktopServicesAvailable } from './platform';

export const REALTIME_SOCKET_CONNECTING = 0;
export const REALTIME_SOCKET_OPEN = 1;
export const REALTIME_SOCKET_CLOSING = 2;
export const REALTIME_SOCKET_CLOSED = 3;

export interface RealtimeSocketCloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export interface RealtimeSocketHandshakePhaseEvent extends Event {
  readonly phase: DesktopRealtimeSocketHandshakePhase;
  readonly durationMs: number;
  readonly routeIndex: number;
  readonly proxied: boolean;
}

export interface RealtimeSocket {
  readonly readyState: number;
  addEventListener(type: 'open' | 'error', listener: (event: Event) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<string>) => void): void;
  addEventListener(type: 'close', listener: (event: RealtimeSocketCloseEvent) => void): void;
  addEventListener(
    type: 'handshakephase',
    listener: (event: RealtimeSocketHandshakePhaseEvent) => void,
  ): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export interface RealtimeSocketBridge {
  closeRealtimeSocket(input: DesktopRealtimeSocketCloseInput): Promise<void>;
  onRealtimeSocketEvent(listener: (event: DesktopRealtimeSocketEvent) => void): () => void;
  openRealtimeSocket(input: DesktopRealtimeSocketOpenInput): Promise<void>;
  sendRealtimeSocket(input: DesktopRealtimeSocketSendInput): Promise<void>;
}

interface RealtimeSocketEventRouter {
  listeners: Map<string, (event: DesktopRealtimeSocketEvent) => void>;
  unsubscribe: (() => void) | null;
}

const eventRouters = new WeakMap<RealtimeSocketBridge, RealtimeSocketEventRouter>();

function subscribeToSocketEvents(
  bridge: RealtimeSocketBridge,
  socketId: string,
  listener: (event: DesktopRealtimeSocketEvent) => void,
): () => void {
  let router = eventRouters.get(bridge);
  if (!router) {
    router = { listeners: new Map(), unsubscribe: null };
    eventRouters.set(bridge, router);
  }
  if (router.listeners.has(socketId)) throw new Error('Realtime socket ID is already subscribed');
  router.listeners.set(socketId, listener);
  router.unsubscribe ??= bridge.onRealtimeSocketEvent((event) => {
    router!.listeners.get(event.socketId)?.(event);
  });
  return () => {
    router!.listeners.delete(socketId);
    if (router!.listeners.size !== 0) return;
    router!.unsubscribe?.();
    router!.unsubscribe = null;
  };
}

class BrokeredCloseEvent extends Event implements RealtimeSocketCloseEvent {
  constructor(
    readonly code: number,
    readonly reason: string,
    readonly wasClean: boolean,
  ) {
    super('close');
  }
}

class BrokeredHandshakePhaseEvent extends Event implements RealtimeSocketHandshakePhaseEvent {
  constructor(
    readonly phase: DesktopRealtimeSocketHandshakePhase,
    readonly durationMs: number,
    readonly routeIndex: number,
    readonly proxied: boolean,
  ) {
    super('handshakephase');
  }
}

class BrokeredRealtimeSocket extends EventTarget implements RealtimeSocket {
  readyState = REALTIME_SOCKET_CONNECTING;
  private readonly pendingHandshakePhases: BrokeredHandshakePhaseEvent[] = [];
  private handshakePhaseObserverAttached = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly bridge: RealtimeSocketBridge,
    private readonly input: DesktopRealtimeSocketOpenInput,
  ) {
    super();
    this.unsubscribe = subscribeToSocketEvents(this.bridge, input.socketId, (event) => {
      if (this.readyState === REALTIME_SOCKET_CLOSED) return;
      if (event.type === 'handshake_phase') {
        const phaseEvent = new BrokeredHandshakePhaseEvent(
          event.phase,
          event.durationMs,
          event.routeIndex,
          event.proxied,
        );
        if (this.handshakePhaseObserverAttached) this.dispatchEvent(phaseEvent);
        else this.pendingHandshakePhases.push(phaseEvent);
      } else if (event.type === 'open') {
        if (this.readyState !== REALTIME_SOCKET_CONNECTING) return;
        this.readyState = REALTIME_SOCKET_OPEN;
        this.dispatchEvent(new Event('open'));
      } else if (event.type === 'message') {
        if (this.readyState !== REALTIME_SOCKET_OPEN) return;
        this.dispatchEvent(new MessageEvent<string>('message', { data: event.data }));
      } else if (event.type === 'error') {
        this.dispatchEvent(new Event('error'));
      } else {
        this.readyState = REALTIME_SOCKET_CLOSED;
        this.unsubscribe();
        this.dispatchEvent(new BrokeredCloseEvent(event.code, event.reason, event.wasClean));
      }
    });
    void this.bridge.openRealtimeSocket(input).catch(() => this.failOpen());
  }

  override addEventListener(type: 'open' | 'error', listener: (event: Event) => void): void;
  override addEventListener(type: 'message', listener: (event: MessageEvent<string>) => void): void;
  override addEventListener(type: 'close', listener: (event: RealtimeSocketCloseEvent) => void): void;
  override addEventListener(
    type: 'handshakephase',
    listener: (event: RealtimeSocketHandshakePhaseEvent) => void,
  ): void;
  override addEventListener(
    type: string,
    listener: ((event: Event) => void)
      | ((event: MessageEvent<string>) => void)
      | ((event: RealtimeSocketCloseEvent) => void)
      | ((event: RealtimeSocketHandshakePhaseEvent) => void),
  ): void {
    super.addEventListener(type, listener as EventListener);
    if (type !== 'handshakephase' || this.handshakePhaseObserverAttached) return;
    this.handshakePhaseObserverAttached = true;
    for (const phase of this.pendingHandshakePhases.splice(0)) this.dispatchEvent(phase);
  }

  send(data: string): void {
    if (this.readyState !== REALTIME_SOCKET_OPEN) throw new Error('Realtime socket is not open');
    void this.bridge.sendRealtimeSocket({ socketId: this.input.socketId, data }).catch(() => {
      this.dispatchEvent(new Event('error'));
    });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === REALTIME_SOCKET_CLOSING || this.readyState === REALTIME_SOCKET_CLOSED) return;
    if (code !== undefined && !validWebSocketCloseCode(code)) {
      throw new DOMException('The close code is not valid.', 'InvalidAccessError');
    }
    if (reason !== undefined && !validWebSocketCloseReason(reason)) {
      throw new DOMException(
        `The close reason must be at most ${MAX_WEBSOCKET_CLOSE_REASON_BYTES} UTF-8 bytes.`,
        'SyntaxError',
      );
    }
    this.readyState = REALTIME_SOCKET_CLOSING;
    void this.bridge.closeRealtimeSocket({ socketId: this.input.socketId, code, reason }).catch(() => {
      this.failOpen();
    });
  }

  private failOpen(): void {
    if (this.readyState === REALTIME_SOCKET_CLOSED) return;
    this.dispatchEvent(new Event('error'));
    this.readyState = REALTIME_SOCKET_CLOSED;
    this.unsubscribe();
    this.dispatchEvent(new BrokeredCloseEvent(1006, '', false));
  }
}

export function createBrokeredRealtimeSocket(
  bridge: RealtimeSocketBridge,
  input: DesktopRealtimeSocketOpenInput,
): RealtimeSocket {
  return new BrokeredRealtimeSocket(bridge, input);
}

export function createRealtimeSocket(
  kind: DesktopRealtimeSocketKind,
  url: string,
  protocols: [string, string],
): RealtimeSocket {
  // The ticket-provenance lint rule checks the two call sites that hand this
  // adapter their ticket URL. This constructor is the browser-development
  // sink for those already-checked values; Electron never reaches it.
  // eslint-disable-next-line rally/require-websocket-ticket
  if (!desktopServicesAvailable()) return new WebSocket(url, protocols);
  return createBrokeredRealtimeSocket(desktopBridge(), {
    socketId: crypto.randomUUID(),
    kind,
    url,
    protocols,
  });
}
