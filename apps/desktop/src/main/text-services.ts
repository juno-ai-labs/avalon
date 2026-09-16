import type { BrowserWindow, Menu, MenuItemConstructorOptions, WebContents } from 'electron';

/**
 * macOS Dictionary and the system share sheet for a message-text selection.
 *
 * Both are main-process OS affordances the renderer cannot reach. The
 * renderer restores the snapshot selection before Look Up, and passes the
 * plain text to share; neither channel invents a payload size cap.
 */

export function showDefinitionForSelection(
  platform: NodeJS.Platform,
  contents: Pick<WebContents, 'showDefinitionForSelection'>,
): void {
  if (platform !== 'darwin') return;
  contents.showDefinitionForSelection();
}

export function shareText(
  platform: NodeJS.Platform,
  text: unknown,
  dependencies: {
    buildMenu: (template: MenuItemConstructorOptions[]) => Pick<Menu, 'popup'>;
    window: BrowserWindow | null;
  },
): void {
  if (platform !== 'darwin') return;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Invalid share text');
  }
  const menu = dependencies.buildMenu([{
    role: 'shareMenu',
    sharingItem: { texts: [text] },
  }]);
  menu.popup(dependencies.window ? { window: dependencies.window } : undefined);
}
