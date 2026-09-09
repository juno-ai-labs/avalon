import { describe, expect, it, vi } from 'vitest';
import { WORKSTREAM_REALTIME_MAX_FRAME_BYTES } from '@rally/contracts';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DesktopRealtimeSocketCloseInputSchema,
  DesktopRealtimeSocketEventSchema,
  type DesktopRealtimeSocketEvent,
  type DesktopRealtimeSocketOpenInput,
} from '../common/realtime-socket';
import {
  RealtimeSocketBroker,
  createNodeRealtimeSocketFactory,
  directSocketServername,
  proxyUrlsFromElectronResolution,
  realtimeSocketTargetAllowed,
  type RealtimeSocketClient,
  type RealtimeSocketFactory,
} from './realtime-socket-broker';

const workstreamId = '00000000-0000-7000-8000-000000000001';
const socketId = '00000000-0000-4000-8000-000000000002';
const ticket = 't'.repeat(40);

function openInput(
  kind: DesktopRealtimeSocketOpenInput['kind'] = 'workstream_control',
): DesktopRealtimeSocketOpenInput {
  return {
    socketId,
    kind,
    url: kind === 'workstream_control'
      ? `wss://api.rallywith.ai/socket/workstreams/${workstreamId}`
      : `wss://api.rallywith.ai/socket/conversations/${workstreamId}/0`,
    protocols: ['rally.ticket.v1', ticket],
  };
}

class FakeSocket implements RealtimeSocketClient {
  extensions = '';
  protocol = 'rally.ticket.v1';
  readyState = 0;
  readonly close = vi.fn(() => { this.readyState = 2; });
  readonly send = vi.fn();
  readonly terminate = vi.fn();
  private closeListener: ((code: number, reason: Uint8Array) => void) | null = null;
  private errorListener: (() => void) | null = null;
  private handshakePhaseListener: Parameters<RealtimeSocketClient['onHandshakePhase']>[0] | null = null;
  private messageListener: ((data: unknown) => void) | null = null;
  private openListener: (() => void) | null = null;

  onClose(listener: (code: number, reason: Uint8Array) => void): void { this.closeListener = listener; }
  onError(listener: () => void): void { this.errorListener = listener; }
  onHandshakePhase(listener: Parameters<RealtimeSocketClient['onHandshakePhase']>[0]): void {
    this.handshakePhaseListener = listener;
  }
  onMessage(listener: (data: unknown) => void): void { this.messageListener = listener; }
  onOpen(listener: () => void): void { this.openListener = listener; }
  emitClose(code: number, reason: string): void {
    this.readyState = 3;
    this.closeListener?.(code, Buffer.from(reason));
  }
  emitError(): void { this.errorListener?.(); }
  emitHandshakePhase(): void {
    this.handshakePhaseListener?.({
      phase: 'proxy_resolution', durationMs: 12.3, routeIndex: 0, proxied: false,
    });
  }
  emitMessage(data: string): void { this.messageListener?.(Buffer.from(data)); }
  emitOpen(): void { this.openListener?.(); }
}

describe('realtimeSocketTargetAllowed', () => {
  const apiBaseUrls = ['https://api.rallywith.ai', 'https://eu.api.rallywith.ai'];

  it('allows only the declared work-stream socket shape on configured regional origins', () => {
    expect(realtimeSocketTargetAllowed(openInput(), apiBaseUrls)).toBe(true);
    expect(realtimeSocketTargetAllowed(openInput('substream_feed'), apiBaseUrls)).toBe(true);
    expect(realtimeSocketTargetAllowed({
      ...openInput(),
      url: `wss://attacker.example/socket/workstreams/${workstreamId}`,
    }, apiBaseUrls)).toBe(false);
    expect(realtimeSocketTargetAllowed({
      ...openInput(),
      url: `${openInput().url}?ticket=leaked`,
    }, apiBaseUrls)).toBe(false);
    expect(realtimeSocketTargetAllowed({
      ...openInput('substream_feed'),
      kind: 'workstream_control',
    }, apiBaseUrls)).toBe(false);
    expect(realtimeSocketTargetAllowed({
      ...openInput(),
      protocols: ['not-rally', ticket],
    }, apiBaseUrls)).toBe(false);
  });

  it('allows the control appearance capability without allowing arbitrary query data', () => {
    expect(realtimeSocketTargetAllowed({ ...openInput(), url: `${openInput().url}?workstreamAppearance=1` }, apiBaseUrls)).toBe(true);
    for (const query of ['ticket=leaked', 'workstreamAppearance=0', 'workstreamAppearance=1&ticket=leaked', 'workstreamAppearance=1&workstreamAppearance=1', 'other=1']) {
      expect(realtimeSocketTargetAllowed({ ...openInput(), url: `${openInput().url}?${query}` }, apiBaseUrls)).toBe(false);
    }
    expect(realtimeSocketTargetAllowed({ ...openInput('substream_feed'), url: `${openInput('substream_feed').url}?workstreamAppearance=1` }, apiBaseUrls)).toBe(false);
  });

  it('admits a feed by its conversation, whichever parent it has, and nothing older', () => {
    const automationId = '00000000-0000-7000-8000-000000000009';
    const runId = '00000000-0000-7000-8000-000000000010';
    // An automation's conversation and one of its runs ride the same route a
    // work stream's feed does.
    expect(realtimeSocketTargetAllowed({
      ...openInput('substream_feed'),
      url: `wss://api.rallywith.ai/socket/conversations/${automationId}/0`,
    }, apiBaseUrls)).toBe(true);
    expect(realtimeSocketTargetAllowed({
      ...openInput('substream_feed'),
      url: `wss://api.rallywith.ai/socket/conversations/${automationId}/${runId}`,
    }, apiBaseUrls)).toBe(true);
    // The retired shapes are refused rather than tolerated.
    expect(realtimeSocketTargetAllowed({
      ...openInput('substream_feed'),
      url: `wss://api.rallywith.ai/socket/workstreams/${workstreamId}/substreams/0`,
    }, apiBaseUrls)).toBe(false);
    expect(realtimeSocketTargetAllowed({
      ...openInput('substream_feed'),
      url: `wss://api.rallywith.ai/socket/automations/${automationId}`,
    }, apiBaseUrls)).toBe(false);
    expect(realtimeSocketTargetAllowed({
      ...openInput('substream_feed'),
      url: `wss://api.rallywith.ai/socket/conversations/${automationId}/0/extra`,
    }, apiBaseUrls)).toBe(false);
  });
});

describe('proxyUrlsFromElectronResolution', () => {
  it('omits TLS SNI for bracketed IPv6 literals', () => {
    expect(directSocketServername('wss://[::1]:8787/socket')).toBe('');
    expect(directSocketServername('wss://api.rallywith.ai/socket')).toBe('api.rallywith.ai');
  });

  it('preserves Electron proxy directives and fallbacks in order', () => {
    expect(proxyUrlsFromElectronResolution('DIRECT')).toEqual(['']);
    expect(proxyUrlsFromElectronResolution(
      'PROXY primary.example:8080; HTTPS secondary.example:8443; DIRECT',
    )).toEqual([
      'http://primary.example:8080',
      'https://secondary.example:8443',
      '',
    ]);
    expect(proxyUrlsFromElectronResolution('SOCKS5 proxy.example:1080'))
      .toEqual(['socks5://proxy.example:1080']);
    expect(() => proxyUrlsFromElectronResolution('UNKNOWN proxy.example:8080'))
      .toThrow('unsupported proxy directive');
  });

  it('advances to the next PAC directive when the first handshake fails', async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const attempts = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const factory = createNodeRealtimeSocketFactory(
      async () => 'PROXY primary.example:8080; PROXY secondary.example:8080; DIRECT',
      attempts,
    );
    const socket = factory(openInput().url, openInput().protocols);
    const opened = vi.fn();
    const failed = vi.fn();
    const phases: string[] = [];
    socket.onOpen(opened);
    socket.onError(failed);
    socket.onHandshakePhase((phase) => phases.push(phase.phase));
    await Promise.resolve();

    expect(attempts).toHaveBeenCalledTimes(1);
    expect(attempts.mock.calls[0]?.[0]).toMatchObject({
      proxyUrl: 'http://primary.example:8080',
      maxPayload: WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
    });
    first.emitError();
    expect(phases).toEqual(['proxy_resolution', 'route_failed']);
    expect(attempts).toHaveBeenCalledTimes(2);
    expect(attempts.mock.calls[1]?.[0]).toMatchObject({
      proxyUrl: 'http://secondary.example:8080',
      maxPayload: WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
    });

    second.readyState = 1;
    second.emitOpen();
    expect(opened).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    expect(first.terminate).toHaveBeenCalledOnce();
  });

  it('closes immediately when the renderer cancels while PAC resolution is pending', async () => {
    let resolveProxy!: (resolution: string) => void;
    const attempts = vi.fn();
    const factory = createNodeRealtimeSocketFactory(
      () => new Promise<string>((resolve) => { resolveProxy = resolve; }),
      attempts,
    );
    const socket = factory(openInput().url, openInput().protocols);
    const closed = vi.fn();
    socket.onClose(closed);

    socket.close(1_000, 'opening timeout');

    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(closed).toHaveBeenCalledWith(1_000, Buffer.from('opening timeout'));
    resolveProxy('DIRECT');
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).not.toHaveBeenCalled();
  });

  it('uses plain TCP for a direct local WebSocket and reports no TLS phase', async () => {
    const httpServer = createServer();
    const server = new WebSocketServer({
      server: httpServer,
      handleProtocols: (protocols) => protocols.has('rally.ticket.v1')
        ? 'rally.ticket.v1'
        : false,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    try {
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('Missing local test address');
      const socket = createNodeRealtimeSocketFactory(async () => 'DIRECT')(
        `ws://127.0.0.1:${address.port}`,
        openInput().protocols,
      );
      const phases: string[] = [];
      socket.onHandshakePhase((phase) => phases.push(phase.phase));
      await new Promise<void>((resolve, reject) => {
        socket.onOpen(resolve);
        socket.onError(() => reject(new Error('Local direct WebSocket failed')));
      });

      expect(socket.protocol).toBe('rally.ticket.v1');
      expect(phases).toContain('edge_upgrade');
      expect(phases).not.toContain('tls');
      socket.close(1_000, 'test complete');
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        }));
      }
    }
  });
});

describe('desktop realtime socket validation', () => {
  it('accepts only generated UUID v4 socket IDs and valid close frames', () => {
    expect(DesktopRealtimeSocketEventSchema.safeParse({
      type: 'error', socketId,
    }).success).toBe(true);
    expect(DesktopRealtimeSocketEventSchema.safeParse({
      type: 'error', socketId: '00000000-0000-0000-0000-000000000000',
    }).success).toBe(false);
    expect(DesktopRealtimeSocketCloseInputSchema.safeParse({
      socketId, code: 1_000, reason: '💡'.repeat(30),
    }).success).toBe(true);
    expect(DesktopRealtimeSocketCloseInputSchema.safeParse({
      socketId, code: 1_005,
    }).success).toBe(false);
    expect(DesktopRealtimeSocketCloseInputSchema.safeParse({
      socketId, code: 1_001,
    }).success).toBe(false);
    expect(DesktopRealtimeSocketCloseInputSchema.safeParse({
      socketId, code: 1_000, reason: '💡'.repeat(31),
    }).success).toBe(false);
  });
});

describe('RealtimeSocketBroker', () => {
  it('starts a work-stream control socket and its feed socket without waiting for either handshake', () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const createSocket = vi.fn<RealtimeSocketFactory>(() => sockets.shift()!);
    const broker = new RealtimeSocketBroker(createSocket);

    broker.open(7, openInput(), vi.fn());
    broker.open(7, { ...openInput('substream_feed'), socketId: crypto.randomUUID() }, vi.fn());

    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(createSocket.mock.calls.map(([url]) => url)).toEqual([
      openInput().url,
      openInput('substream_feed').url,
    ]);
  });

  it('relays lifecycle and text frames and addresses sends by renderer owner', () => {
    const socket = new FakeSocket();
    const events: DesktopRealtimeSocketEvent[] = [];
    const broker = new RealtimeSocketBroker((_url, _protocols, onHandshakePhase) => {
      if (onHandshakePhase) socket.onHandshakePhase(onHandshakePhase);
      return socket;
    });
    broker.open(7, openInput(), (event) => events.push(event));

    socket.readyState = 1;
    socket.emitHandshakePhase();
    socket.emitOpen();
    socket.emitMessage('{"type":"snapshot"}');
    broker.send(7, socketId, 'ping');
    expect(() => broker.send(8, socketId, 'ping')).toThrow('not open');
    socket.emitClose(1000, 'done');

    expect(socket.send).toHaveBeenCalledWith('ping');
    expect(events).toEqual([
      {
        type: 'handshake_phase',
        socketId,
        phase: 'proxy_resolution',
        durationMs: 12.3,
        routeIndex: 0,
        proxied: false,
      },
      expect.objectContaining({ type: 'open', socketId }),
      { type: 'message', socketId, data: '{"type":"snapshot"}' },
      { type: 'close', socketId, code: 1000, reason: 'done', wasClean: true },
    ]);
  });

  it('retains a handshake phase emitted during client construction until ownership is registered', () => {
    const socket = new FakeSocket();
    const events: DesktopRealtimeSocketEvent[] = [];
    const broker = new RealtimeSocketBroker((_url, _protocols, onHandshakePhase) => {
      onHandshakePhase?.({
        phase: 'proxy_resolution',
        durationMs: 8.7,
        routeIndex: 0,
        proxied: false,
      });
      return socket;
    });

    broker.open(7, openInput(), (event) => events.push(event));

    expect(events).toEqual([{
      type: 'handshake_phase',
      socketId,
      phase: 'proxy_resolution',
      durationMs: 8.7,
      routeIndex: 0,
      proxied: false,
    }]);
  });

  it('terminates every socket owned by a renderer and suppresses late events', () => {
    const socket = new FakeSocket();
    const emit = vi.fn();
    const broker = new RealtimeSocketBroker(() => socket);
    broker.open(7, openInput(), emit);

    broker.closeOwner(7);
    socket.emitOpen();

    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });

  it('terminates and forgets a socket when the native close call throws', () => {
    const socket = new FakeSocket();
    socket.readyState = 1;
    socket.close.mockImplementation(() => { throw new TypeError('invalid close frame'); });
    const broker = new RealtimeSocketBroker(() => socket);
    broker.open(7, openInput(), vi.fn());

    expect(() => broker.close(7, socketId, 1_000, 'done')).toThrow('invalid close frame');
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(() => broker.send(7, socketId, 'ping')).toThrow('not open');
  });

  it('forwards a normal close once, forgets the socket, and leaves other owners alone', () => {
    const first = new FakeSocket();
    const otherOwner = new FakeSocket();
    const replacement = new FakeSocket();
    first.readyState = 1;
    otherOwner.readyState = 1;
    const sockets = [first, otherOwner, replacement];
    const events: DesktopRealtimeSocketEvent[] = [];
    const broker = new RealtimeSocketBroker(() => sockets.shift()!);
    broker.open(7, openInput(), (event) => events.push(event));
    broker.open(8, openInput(), vi.fn());

    broker.close(7, socketId, 1_000, 'done');
    broker.close(7, socketId, 1_000, 'done');
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledWith(1_000, 'done');
    first.emitClose(1_000, 'done');
    first.emitClose(1_000, 'duplicate');

    expect(events).toEqual([
      { type: 'close', socketId, code: 1_000, reason: 'done', wasClean: true },
    ]);
    expect(() => broker.send(7, socketId, 'ping')).toThrow('not open');
    expect(() => broker.send(8, socketId, 'ping')).not.toThrow();
    expect(() => broker.open(7, openInput(), vi.fn())).not.toThrow();
  });
});
