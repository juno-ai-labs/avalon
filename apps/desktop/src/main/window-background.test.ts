import { describe, expect, it, vi } from 'vitest';

import { themeWindowBackground } from '../common/themes';
import { repaintWindowBackgrounds } from './window-background';

function window(destroyed = false) {
  return { isDestroyed: () => destroyed, setBackgroundColor: vi.fn() };
}

describe('repaintWindowBackgrounds', () => {
  it('paints every open window the background of the appearance the choice resolves to', () => {
    const main = window();
    const settings = window();
    repaintWindowBackgrounds([main, settings], 'dark', false);
    expect(main.setBackgroundColor).toHaveBeenCalledWith(themeWindowBackground.dark);
    expect(settings.setBackgroundColor).toHaveBeenCalledWith(themeWindowBackground.dark);
  });

  it('follows the Mac under System, and skips a window already destroyed', () => {
    const open = window();
    const closed = window(true);
    repaintWindowBackgrounds([open, closed], 'system', false);
    expect(open.setBackgroundColor).toHaveBeenCalledWith(themeWindowBackground.light);
    repaintWindowBackgrounds([open, closed], 'system', true);
    expect(open.setBackgroundColor).toHaveBeenLastCalledWith(themeWindowBackground.dark);
    expect(closed.setBackgroundColor).not.toHaveBeenCalled();
  });
});
