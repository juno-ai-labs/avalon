import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { WORKSPACE_SYNC_RELAY_IPC_CHANNELS } from '../common/workspace-sync-relay';
import type { WorkspaceSyncRelay } from './workspace-sync-relay';

interface WorkspaceSyncRelayIpcDependencies {
  /** The shared check every Rally IPC handler starts with: a Rally window, on Rally's own page. */
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  ipc: Pick<IpcMain, 'handle'>;
  /** The main window's renderer, when there is one: the only publisher. */
  mainWindowContents: () => WebContents | null | undefined;
  relay: Pick<WorkspaceSyncRelay, 'publish' | 'snapshot'>;
  /** The Settings window's renderer, when there is one: the only consumer. */
  settingsWindowContents: () => WebContents | null | undefined;
}

/**
 * Register the relay's two invoke channels with their sender checks. The
 * third, `relayed`, is main's own send to the Settings window and has no
 * handler.
 */
export function registerWorkspaceSyncRelayIpc({
  assertTrustedSender,
  ipc,
  mainWindowContents,
  relay,
  settingsWindowContents,
}: WorkspaceSyncRelayIpcDependencies): void {
  ipc.handle(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.publish, (event, raw: unknown) => {
    assertTrustedSender(event);
    const main = mainWindowContents();
    if (!main || event.sender !== main) throw new Error('Only the main Rally window can publish organization sync');
    relay.publish(raw);
  });
  ipc.handle(WORKSPACE_SYNC_RELAY_IPC_CHANNELS.source, (event) => {
    assertTrustedSender(event);
    const settings = settingsWindowContents();
    if (!settings || event.sender !== settings) {
      throw new Error('Only the settings window consumes the relayed organization sync');
    }
    return relay.snapshot();
  });
}
