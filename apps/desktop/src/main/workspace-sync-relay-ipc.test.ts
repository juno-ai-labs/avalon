import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { WORKSPACE_SYNC_RELAY_IPC_CHANNELS, type WorkspaceSyncRelayEvent } from '../common/workspace-sync-relay';
import { WorkspaceSyncRelay } from './workspace-sync-relay';
import { registerWorkspaceSyncRelayIpc } from './workspace-sync-relay-ipc';

const workspaceId = '00000000-0000-7000-8000-000000000001';
const region = 'global';
const connected = { type: 'state', region, workspaceId, state: 'connected' };

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function harness(windows: { main?: boolean; settings?: boolean } = { main: true, settings: true }) {
  const mainContents = { id: 1 } as unknown as WebContents;
  const settingsContents = { id: 2 } as unknown as WebContents;
  const sidekicksContents = { id: 3 } as unknown as WebContents;
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: vi.fn((channel: string, listener: Handler) => {
      handlers.set(channel, listener);
    }),
  } as unknown as Pick<IpcMain, 'handle'>;
  const delivered: WorkspaceSyncRelayEvent[] = [];
  const relay = new WorkspaceSyncRelay((event) => delivered.push(event));
  const assertTrustedSender = vi.fn();
  registerWorkspaceSyncRelayIpc({
    assertTrustedSender,
    ipc,
    mainWindowContents: () => (windows.main ? mainContents : null),
    relay,
    settingsWindowContents: () => (windows.settings ? settingsContents : undefined),
  });
  const from = (sender: WebContents) => ({ sender }) as unknown as IpcMainInvokeEvent;
  return {
    assertTrustedSender,
    delivered,
    fromMain: from(mainContents),
    fromSettings: from(settingsContents),
    fromSidekicks: from(sidekicksContents),
    invoke: (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => handlers.get(channel)!(event, ...args),
    handlers,
    relay,
  };
}

describe('workspace sync relay IPC', () => {
  it('registers the two invoke channels, and nothing for main\'s own send', () => {
    expect([...harness().handlers.keys()].sort()).toEqual([
      WORKSPACE_SYNC_RELAY_IPC_CHANNELS.publish,
      WORKSPACE_SYNC_RELAY_IPC_CHANNELS.source,
    ].sort());
  });

  it('takes publications from the main window only', () => {
    const subject = harness();
    for (const event of [subject.fromSettings, subject.fromSidekicks]) {
      expect(() => subject.invoke(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.publish, event, connected))
        .toThrow('Only the main Rally window can publish organization sync');
    }
    expect(subject.relay.snapshot()).toEqual({ revision: 0, source: null });
    expect(subject.delivered).toEqual([]);

    subject.invoke(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.publish, subject.fromMain, connected);
    expect(subject.assertTrustedSender).toHaveBeenCalledWith(subject.fromMain);
    expect(subject.delivered).toEqual([{ type: 'source', revision: 1, source: { region, workspaceId, state: 'connected' } }]);
  });

  it('answers the source to the settings window only', () => {
    const subject = harness();
    subject.invoke(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.publish, subject.fromMain, connected);
    for (const event of [subject.fromMain, subject.fromSidekicks]) {
      expect(() => subject.invoke(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.source, event))
        .toThrow('Only the settings window consumes the relayed organization sync');
    }
    expect(subject.invoke(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.source, subject.fromSettings))
      .toEqual({ revision: 1, source: { region, workspaceId, state: 'connected' } });
  });

  it('refuses both channels while the window each is reserved for does not exist', () => {
    const subject = harness({});
    const nobody = { sender: undefined } as unknown as IpcMainInvokeEvent;
    expect(() => subject.invoke(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.publish, nobody, connected))
      .toThrow('Only the main Rally window can publish organization sync');
    expect(() => subject.invoke(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.source, nobody))
      .toThrow('Only the settings window consumes the relayed organization sync');
  });

  it('runs the shared trusted-sender check first', () => {
    const subject = harness();
    subject.assertTrustedSender.mockImplementation(() => {
      throw new Error('Blocked IPC request from untrusted content');
    });
    expect(() => subject.invoke(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.publish, subject.fromMain, connected))
      .toThrow('Blocked IPC request from untrusted content');
    expect(() => subject.invoke(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.source, subject.fromSettings))
      .toThrow('Blocked IPC request from untrusted content');
    expect(subject.delivered).toEqual([]);
  });
});
