import { describe, expect, it, vi } from 'vitest';
import { shareText, showDefinitionForSelection } from './text-services';

describe('message text OS services', () => {
  it('shows the Dictionary popover only on macOS', () => {
    const contents = { showDefinitionForSelection: vi.fn() };
    showDefinitionForSelection('linux', contents);
    expect(contents.showDefinitionForSelection).not.toHaveBeenCalled();
    showDefinitionForSelection('darwin', contents);
    expect(contents.showDefinitionForSelection).toHaveBeenCalledOnce();
  });

  it('opens the share sheet with the given text on macOS', () => {
    const popup = vi.fn();
    const buildMenu = vi.fn(() => ({ popup }));
    const window = {} as Electron.BrowserWindow;
    shareText('darwin', 'Selected line', { buildMenu, window });
    expect(buildMenu).toHaveBeenCalledWith([{
      role: 'shareMenu',
      sharingItem: { texts: ['Selected line'] },
    }]);
    expect(popup).toHaveBeenCalledWith({ window });
  });

  it('does not open a share sheet off macOS, and rejects an empty payload', () => {
    const popup = vi.fn();
    const buildMenu = vi.fn(() => ({ popup }));
    shareText('win32', 'Selected line', { buildMenu, window: null });
    expect(buildMenu).not.toHaveBeenCalled();
    expect(() => shareText('darwin', '', { buildMenu, window: null })).toThrow('Invalid share text');
    expect(() => shareText('darwin', 12, { buildMenu, window: null })).toThrow('Invalid share text');
  });
});
