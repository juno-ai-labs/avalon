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
    const popupShare = vi.fn();
    const window = {} as Electron.BrowserWindow;
    shareText('darwin', 'Selected line', { popupShare, window });
    expect(popupShare).toHaveBeenCalledWith({ texts: ['Selected line'] }, window);
  });

  it('rejects a bad payload before the platform check, and does not open off macOS', () => {
    const popupShare = vi.fn();
    expect(() => shareText('win32', '', { popupShare, window: null })).toThrow('Invalid share text');
    expect(() => shareText('linux', 12, { popupShare, window: null })).toThrow('Invalid share text');
    shareText('win32', 'Selected line', { popupShare, window: null });
    expect(popupShare).not.toHaveBeenCalled();
  });
});
