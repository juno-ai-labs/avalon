// @vitest-environment node
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { applicationMenuTemplate, updateMenuItem } from './application-menu';

function actions() {
  return {
    openSettings: vi.fn(),
    openWebsite: vi.fn(),
    checkForUpdates: vi.fn(),
    installDownloadedUpdate: vi.fn(),
  };
}

describe('application menu update lifecycle', () => {
  it('maps updater states to idiomatic macOS menu items', () => {
    const callbacks = actions();
    expect(updateMenuItem({ kind: 'idle' }, callbacks)).toMatchObject({
      label: 'Check for Updates…',
      click: callbacks.checkForUpdates,
    });
    expect(updateMenuItem({ kind: 'checking' }, callbacks)).toEqual({
      label: 'Checking for Updates…',
      enabled: false,
    });
    expect(updateMenuItem({ kind: 'downloading', percent: 47.6 }, callbacks)).toEqual({
      label: 'Downloading Update… 48%',
      enabled: false,
    });
    expect(updateMenuItem({ kind: 'downloaded', version: '1.2.3' }, callbacks)).toMatchObject({
      label: 'Restart to Update 1.2.3',
      click: callbacks.installDownloadedUpdate,
    });
  });

  it('keeps Settings in the macOS app menu and the website in Help', () => {
    const callbacks = actions();
    const template = applicationMenuTemplate({
      appName: 'Avalon',
      platform: 'darwin',
      updateStatus: { kind: 'idle' },
      actions: callbacks,
    });
    const appItems = template[0]!.submenu as MenuItemConstructorOptions[];
    const helpItems = template.at(-1)!.submenu as MenuItemConstructorOptions[];

    expect(template[0]!.label).toBe('Avalon');
    expect(appItems.find((item) => item.label === 'Settings…')).toMatchObject({
      accelerator: 'CmdOrCtrl+,',
      click: callbacks.openSettings,
    });
    expect(helpItems).toContainEqual(expect.objectContaining({
      label: 'Avalon website',
      click: callbacks.openWebsite,
    }));
  });
});
