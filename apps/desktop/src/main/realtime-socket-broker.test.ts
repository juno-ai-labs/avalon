import { describe, expect, it, vi } from 'vitest';
import {
  DesktopRealtimeSocketCloseInputSchema,
  DesktopRealtimeSocketEventSchema,
  type DesktopRealtimeSocketEvent,
  type DesktopRealtimeSocketOpenInput,
} from '../common/realtime-socket';
import {
  RealtimeSocketBroker,
  proxyUrlFromElectronResolution,
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
      : `wss://api.rallywith.ai/socket/workstreams/${workstreamId}/substreams/0`,
    protocols: ['rally.ticket.v1', ticket],
  };
}

class FakeSocket implements RealtimeSocketClient {
  extensions = '';
  protocol = 'rally.ticket.v1';
  readyState = 0;
  readonly close = vi.fn();
  readonly send = vi.fn();
  readonly terminate = vi.fn();
  private closeListener: ((code: number, reason: Uint8Array) => void) | null = null;
  private errorListener: (() => void) | null = null;
  private messageListener: ((data: unknown) => void) | null = null;
  private openListener: (() => void) | null = null;

  onClose(listener: (code: number, reason: Uint8Array) => void): void { this.closeListener = listener; }
  onError(listener: () => void): void { this.errorListener = listener; }
  onMessage(listener: (data: unknown) => void): void { this.messageListener = listener; }
  onOpen(listener: () => void): void { this.openListener = listener; }
  emitClose(code: number, reason: string): void { this.closeListener?.(code, Buffer.from(reason)); }
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
});

describe('proxyUrlFromElectronResolution', () => {
  it('translates Electron proxy directives for the Node socket agent', () => {
    expect(proxyUrlFromElectronResolution('DIRECT')).toBe('');
    expect(proxyUrlFromElectronResolution('PROXY proxy.example:8080; DIRECT'))
      .toBe('http://proxy.example:8080');
    expect(proxyUrlFromElectronResolution('HTTPS proxy.example:8443'))
      .toBe('https://proxy.example:8443');
    expect(proxyUrlFromElectronResolution('SOCKS5 proxy.example:1080'))
      .toBe('socks5://proxy.example:1080');
    expect(() => proxyUrlFromElectronResolution('UNKNOWN proxy.example:8080'))
      .toThrow('unsupported proxy directive');
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
    const broker = new RealtimeSocketBroker(() => socket);
    broker.open(7, openInput(), (event) => events.push(event));

    socket.readyState = 1;
    socket.emitOpen();
    socket.emitMessage('{"type":"snapshot"}');
    broker.send(7, socketId, 'ping');
    expect(() => broker.send(8, socketId, 'ping')).toThrow('not open');
    socket.emitClose(1000, 'done');

    expect(socket.send).toHaveBeenCalledWith('ping');
    expect(events).toEqual([
      expect.objectContaining({ type: 'open', socketId }),
      { type: 'message', socketId, data: '{"type":"snapshot"}' },
      { type: 'close', socketId, code: 1000, reason: 'done', wasClean: true },
    ]);
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
});
