import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopRealtimeSocketEvent } from '../common/realtime-socket';
import {
  REALTIME_SOCKET_IPC_CHANNELS,
  parseRealtimeSocketEvent,
} from '../common/realtime-socket-validation';
import { registerRealtimeSocketIpc } from './realtime-socket-ipc';

const workstreamId = '00000000-0000-7000-8000-000000000001';
const socketId = '00000000-0000-4000-8000-000000000002';

function harness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    }),
  } as unknown as Pick<IpcMain, 'handle'>;
  const broker = {
    close: vi.fn(),
    open: vi.fn(),
    send: vi.fn(),
  };
  const assertSender = vi.fn();
  registerRealtimeSocketIpc({
    apiBaseUrls: ['https://api.rallywith.ai'],
    assertSender,
    broker,
    ipc,
  });
  const send = vi.fn();
  const event = {
    sender: { id: 17, isDestroyed: () => false, send },
  } as unknown as IpcMainInvokeEvent;
  return { assertSender, broker, event, handlers, send };
}

function openInput() {
  return {
    socketId,
    kind: 'substream_feed' as const,
    url: `wss://api.rallywith.ai/socket/conversations/${workstreamId}/0`,
    protocols: ['rally.ticket.v1', 't'.repeat(40)] as [string, string],
  };
}

describe('realtime socket IPC', () => {
  it('registers the shared channels and carries a broker event through preload validation', () => {
    const { assertSender, broker, event, handlers, send } = harness();
    expect([...handlers.keys()].sort()).toEqual([
      REALTIME_SOCKET_IPC_CHANNELS.close,
      REALTIME_SOCKET_IPC_CHANNELS.open,
      REALTIME_SOCKET_IPC_CHANNELS.send,
    ].sort());

    handlers.get(REALTIME_SOCKET_IPC_CHANNELS.open)!(event, openInput());
    expect(assertSender).toHaveBeenCalledWith(event);
    expect(broker.open).toHaveBeenCalledWith(17, openInput(), expect.any(Function));
    const emit = broker.open.mock.calls[0]?.[2] as (socketEvent: DesktopRealtimeSocketEvent) => void;
    const socketEvent: DesktopRealtimeSocketEvent = {
      type: 'message', socketId, data: '{"type":"snapshot"}',
    };
    emit(socketEvent);

    expect(send).toHaveBeenCalledWith(REALTIME_SOCKET_IPC_CHANNELS.event, socketEvent);
    expect(parseRealtimeSocketEvent(send.mock.calls[0]?.[1])).toEqual(socketEvent);
  });

  it('rejects malformed input and an unauthorized sender before broker admission', () => {
    const malformed = harness();
    expect(() => malformed.handlers.get(REALTIME_SOCKET_IPC_CHANNELS.open)!(
      malformed.event,
      { ...openInput(), socketId: 'not-a-socket-id' },
    )).toThrow();
    expect(malformed.broker.open).not.toHaveBeenCalled();

    const unauthorized = harness();
    unauthorized.assertSender.mockImplementation(() => {
      throw new Error('Only the main Rally window can open realtime sockets');
    });
    expect(() => unauthorized.handlers.get(REALTIME_SOCKET_IPC_CHANNELS.open)!(
      unauthorized.event,
      openInput(),
    )).toThrow('Only the main Rally window');
    expect(unauthorized.broker.open).not.toHaveBeenCalled();
  });
});
