import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { NetworkRecovery } from './network-recovery';
import { registerNetworkRecoveryIpc } from './network-recovery-ipc';
import { NETWORK_RECOVERY_IPC } from '../common/network-recovery';

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, raw?: unknown) => unknown>();
  const ipc = { handle: (channel: string, handler: (event: IpcMainInvokeEvent, raw?: unknown) => unknown) => {
    handlers.set(channel, handler);
  } } as Pick<IpcMain, 'handle'>;
  const closeConnections = vi.fn(async () => undefined);
  const recovery = new NetworkRecovery({ closeConnections, publish: () => undefined, record: () => undefined });
  const trusted = {} as IpcMainInvokeEvent;
  registerNetworkRecoveryIpc({ ipc, recovery, assertSender: (event) => {
    if (event !== trusted) throw new Error('untrusted_sender');
  } });
  return { recovery, closeConnections, handlers, trusted };
}

describe('network recovery IPC', () => {
  it('runs the shared recovery through a closed trusted observation boundary', () => {
    const { handlers, trusted, recovery, closeConnections } = harness();
    const observe = handlers.get(NETWORK_RECOVERY_IPC.observe)!;
    observe(trusted, { generation: 0, target: '/workspace/socket', outcome: 'timeout' });
    expect(closeConnections).not.toHaveBeenCalled();
    observe(trusted, { generation: 0, target: '/workspace/socket', outcome: 'timeout' });
    expect(closeConnections).toHaveBeenCalledTimes(1);
    expect(handlers.get(NETWORK_RECOVERY_IPC.state)!(trusted)).toEqual({ generation: 1, phase: 'resetting' });
    expect(recovery.state.generation).toBe(1);
  });

  it('refuses untrusted senders and names malformed fields without echoing their data', () => {
    const { handlers, trusted, closeConnections } = harness();
    const observe = handlers.get(NETWORK_RECOVERY_IPC.observe)!;
    expect(() => observe({} as IpcMainInvokeEvent, {})).toThrow('untrusted_sender');
    expect(() => observe(trusted, { generation: 0, target: '/workspace/socket?ticket=secret', outcome: 'timeout' }))
      .toThrow(/target/);
    expect(() => observe(trusted, { generation: 0, target: '/workspace/socket', outcome: 'arbitrary_secret' }))
      .toThrow(/outcome/);
    try {
      observe(trusted, { generation: 0, target: '/workspace/socket?ticket=secret', outcome: 'timeout' });
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
    expect(closeConnections).not.toHaveBeenCalled();
  });
});
