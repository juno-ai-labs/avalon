import type { MenuItemConstructorOptions } from 'electron';
import type { UpdateStatus } from './updater';

export interface ApplicationMenuActions {
  readonly openSettings: () => void;
  readonly openWebsite: () => void;
  readonly checkForUpdates: () => void;
  readonly installDownloadedUpdate: () => void;
}

export interface ApplicationMenuOptions {
  readonly appName: string;
  readonly platform: NodeJS.Platform;
  readonly updateStatus: UpdateStatus;
  readonly actions: ApplicationMenuActions;
}

export function updateMenuItem(
  status: UpdateStatus,
  actions: Pick<ApplicationMenuActions, 'checkForUpdates' | 'installDownloadedUpdate'>,
): MenuItemConstructorOptions {
  switch (status.kind) {
    case 'idle':
      return { label: 'Check for Updates…', click: actions.checkForUpdates };
    case 'checking':
      return { label: 'Checking for Updates…', enabled: false };
    case 'downloading': {
      const progress = status.percent === undefined ? '' : ` ${Math.round(status.percent)}%`;
      return { label: `Downloading Update…${progress}`, enabled: false };
    }
    case 'downloaded':
      return {
        label: `Restart to Update ${status.version}`,
        click: actions.installDownloadedUpdate,
      };
  }
}

/** Build a plain Electron menu template so the lifecycle mapping is testable. */
export function applicationMenuTemplate(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: options.actions.openSettings,
  };
  const updateItem = updateMenuItem(options.updateStatus, options.actions);
  const leadingMenu: MenuItemConstructorOptions = options.platform === 'darwin'
    ? {
        label: options.appName,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          updateItem,
          { type: 'separator' },
          settingsItem,
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }
    : {
        label: 'File',
        submenu: [updateItem, { type: 'separator' }, settingsItem, { type: 'separator' }, { role: 'quit' }],
      };

  return [
    leadingMenu,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Avalon website', click: options.actions.openWebsite }],
    },
  ];
}
