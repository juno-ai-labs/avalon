import { describe, expect, it, vi } from 'vitest';
import type { DesktopRealtimeSocketEvent } from '../../common/realtime-socket';
import {
  createBrokeredRealtimeSocket,
  REALTIME_SOCKET_CLOSED,
  REALTIME_SOCKET_CLOSING,
  REALTIME_SOCKET_OPEN,
  type RealtimeSocketBridge,
} from './realtime-socket';

describe('desktop realtime socket adapter', () => {
  it('preserves the WebSocket event and ready-state contract across the preload bridge', async () => {
    let emit: ((event: DesktopRealtimeSocketEvent) => void) | null = null;
    const openRealtimeSocket = vi.fn(async () => undefined);
    const sendRealtimeSocket = vi.fn(async () => undefined);
    const closeRealtimeSocket = vi.fn(async () => undefined);
    const bridge = {
      openRealtimeSocket,
      sendRealtimeSocket,
      closeRealtimeSocket,
      onRealtimeSocketEvent(listener) {
        emit = listener;
        return () => { emit = null; };
      },
    } satisfies RealtimeSocketBridge;
    const input = {
      socketId: crypto.randomUUID(),
      kind: 'substream_feed' as const,
      url: 'wss://api.rallywith.ai/socket/workstreams/00000000-0000-7000-8000-000000000001/substreams/0',
      protocols: ['rally.ticket.v1', 't'.repeat(40)] as [string, string],
    };
    const socket = createBrokeredRealtimeSocket(bridge, input);
    const onOpen = vi.fn();
    const onHandshakePhase = vi.fn();
    const onMessage = vi.fn();
    const onClose = vi.fn();
    socket.addEventListener('open', onOpen);
    socket.addEventListener('handshakephase', onHandshakePhase);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    expect(openRealtimeSocket).toHaveBeenCalledWith(input);

    emit!({
      type: 'handshake_phase', socketId: input.socketId, phase: 'tls',
      durationMs: 24.6, routeIndex: 0, proxied: false,
    });
    expect(onHandshakePhase.mock.calls[0]![0]).toEqual(expect.objectContaining({
      phase: 'tls',
      durationMs: 24.6,
      routeIndex: 0,
      proxied: false,
    }));

    emit!({ type: 'open', socketId: input.socketId, protocol: 'rally.ticket.v1', extensions: '' });
    expect(socket.readyState).toBe(REALTIME_SOCKET_OPEN);
    expect(onOpen).toHaveBeenCalledOnce();

    emit!({ type: 'message', socketId: input.socketId, data: '{"type":"snapshot"}' });
    expect(onMessage.mock.calls[0]![0].data).toBe('{"type":"snapshot"}');
    socket.send('ping');
    expect(sendRealtimeSocket).toHaveBeenCalledWith({ socketId: input.socketId, data: 'ping' });

    socket.close(1000, 'done');
    expect(socket.readyState).toBe(REALTIME_SOCKET_CLOSING);
    expect(closeRealtimeSocket).toHaveBeenCalledWith({ socketId: input.socketId, code: 1000, reason: 'done' });
    emit!({ type: 'close', socketId: input.socketId, code: 1000, reason: 'done', wasClean: true });
    expect(socket.readyState).toBe(REALTIME_SOCKET_CLOSED);
    expect(onClose.mock.calls[0]![0]).toEqual(expect.objectContaining({
      code: 1000,
      reason: 'done',
      wasClean: true,
    }));
  });

  it('multiplexes a socket swarm through one preload listener and routes by socket ID', () => {
    let emit: ((event: DesktopRealtimeSocketEvent) => void) | null = null;
    const onRealtimeSocketEvent = vi.fn((listener: (event: DesktopRealtimeSocketEvent) => void) => {
      emit = listener;
      return () => { emit = null; };
    });
    const bridge = {
      openRealtimeSocket: vi.fn(async () => undefined),
      sendRealtimeSocket: vi.fn(async () => undefined),
      closeRealtimeSocket: vi.fn(async () => undefined),
      onRealtimeSocketEvent,
    } satisfies RealtimeSocketBridge;
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const shared = {
      kind: 'workstream_control' as const,
      url: 'wss://api.rallywith.ai/socket/workstreams/00000000-0000-7000-8000-000000000001',
      protocols: ['rally.ticket.v1', 't'.repeat(40)] as [string, string],
    };
    const first = createBrokeredRealtimeSocket(bridge, { ...shared, socketId: firstId });
    const second = createBrokeredRealtimeSocket(bridge, { ...shared, socketId: secondId });
    const firstOpen = vi.fn();
    const secondOpen = vi.fn();
    first.addEventListener('open', firstOpen);
    second.addEventListener('open', secondOpen);

    expect(onRealtimeSocketEvent).toHaveBeenCalledOnce();
    emit!({ type: 'open', socketId: secondId, protocol: 'rally.ticket.v1', extensions: '' });
    expect(firstOpen).not.toHaveBeenCalled();
    expect(secondOpen).toHaveBeenCalledOnce();

    emit!({ type: 'close', socketId: firstId, code: 1000, reason: '', wasClean: true });
    expect(emit).not.toBeNull();
    emit!({ type: 'close', socketId: secondId, code: 1000, reason: '', wasClean: true });
    expect(emit).toBeNull();
  });

  it('never transitions from locally closing back to open', () => {
    let emit: ((event: DesktopRealtimeSocketEvent) => void) | null = null;
    const bridge = {
      openRealtimeSocket: vi.fn(async () => undefined),
      sendRealtimeSocket: vi.fn(async () => undefined),
      closeRealtimeSocket: vi.fn(async () => undefined),
      onRealtimeSocketEvent(listener: (event: DesktopRealtimeSocketEvent) => void) {
        emit = listener;
        return () => { emit = null; };
      },
    } satisfies RealtimeSocketBridge;
    const input = {
      socketId: crypto.randomUUID(),
      kind: 'substream_feed' as const,
      url: 'wss://api.rallywith.ai/socket/workstreams/00000000-0000-7000-8000-000000000001/substreams/0',
      protocols: ['rally.ticket.v1', 't'.repeat(40)] as [string, string],
    };
    const socket = createBrokeredRealtimeSocket(bridge, input);
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);

    socket.close();
    emit!({ type: 'open', socketId: input.socketId, protocol: 'rally.ticket.v1', extensions: '' });
    emit!({ type: 'message', socketId: input.socketId, data: 'late' });

    expect(socket.readyState).toBe(REALTIME_SOCKET_CLOSING);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(() => socket.send('ping')).toThrow('not open');
  });

  it('rejects invalid close frames before changing state or invoking main', () => {
    const closeRealtimeSocket = vi.fn(async () => undefined);
    const bridge = {
      openRealtimeSocket: vi.fn(async () => undefined),
      sendRealtimeSocket: vi.fn(async () => undefined),
      closeRealtimeSocket,
      onRealtimeSocketEvent: vi.fn(() => () => undefined),
    } satisfies RealtimeSocketBridge;
    const input = {
      socketId: crypto.randomUUID(),
      kind: 'workstream_control' as const,
      url: 'wss://api.rallywith.ai/socket/workstreams/00000000-0000-7000-8000-000000000001',
      protocols: ['rally.ticket.v1', 't'.repeat(40)] as [string, string],
    };
    const invalidCode = createBrokeredRealtimeSocket(bridge, input);
    expect(() => invalidCode.close(1_005)).toThrow(DOMException);
    expect(invalidCode.readyState).not.toBe(REALTIME_SOCKET_CLOSING);

    const invalidReason = createBrokeredRealtimeSocket(bridge, {
      ...input, socketId: crypto.randomUUID(),
    });
    expect(() => invalidReason.close(1_000, '💡'.repeat(31))).toThrow(DOMException);
    expect(invalidReason.readyState).not.toBe(REALTIME_SOCKET_CLOSING);
    expect(closeRealtimeSocket).not.toHaveBeenCalled();
  });
});
