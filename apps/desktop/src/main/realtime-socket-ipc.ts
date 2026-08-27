import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  DesktopRealtimeSocketCloseInputSchema,
  DesktopRealtimeSocketOpenInputSchema,
  DesktopRealtimeSocketSendInputSchema,
} from '../common/realtime-socket';
import { REALTIME_SOCKET_IPC_CHANNELS } from '../common/realtime-socket-validation';
import {
  realtimeSocketTargetAllowed,
  type RealtimeSocketBroker,
} from './realtime-socket-broker';

interface RealtimeSocketIpcDependencies {
  apiBaseUrls: readonly string[];
  assertSender: (event: IpcMainInvokeEvent) => void;
  broker: Pick<RealtimeSocketBroker, 'close' | 'open' | 'send'>;
  ipc: Pick<IpcMain, 'handle'>;
}

/** Register the complete, closed IPC path used by packaged realtime sockets. */
export function registerRealtimeSocketIpc({
  apiBaseUrls,
  assertSender,
  broker,
  ipc,
}: RealtimeSocketIpcDependencies): void {
  ipc.handle(REALTIME_SOCKET_IPC_CHANNELS.open, (event, rawInput: unknown) => {
    assertSender(event);
    const input = DesktopRealtimeSocketOpenInputSchema.parse(rawInput);
    if (!realtimeSocketTargetAllowed(input, apiBaseUrls)) {
      throw new Error('Blocked realtime socket target');
    }
    broker.open(event.sender.id, input, (socketEvent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(REALTIME_SOCKET_IPC_CHANNELS.event, socketEvent);
      }
    });
  });
  ipc.handle(REALTIME_SOCKET_IPC_CHANNELS.send, (event, rawInput: unknown) => {
    assertSender(event);
    const input = DesktopRealtimeSocketSendInputSchema.parse(rawInput);
    broker.send(event.sender.id, input.socketId, input.data);
  });
  ipc.handle(REALTIME_SOCKET_IPC_CHANNELS.close, (event, rawInput: unknown) => {
    assertSender(event);
    const input = DesktopRealtimeSocketCloseInputSchema.parse(rawInput);
    broker.close(event.sender.id, input.socketId, input.code, input.reason);
  });
}
