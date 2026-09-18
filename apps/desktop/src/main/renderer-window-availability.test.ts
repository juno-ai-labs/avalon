import { describe, expect, it, vi } from 'vitest';
import { availableRendererWindows } from './renderer-window-availability';

function rendererWindow(options: {
  windowDestroyed?: boolean;
  contentsDestroyed?: boolean;
  contentsCrashed?: boolean;
} = {}) {
  return {
    isDestroyed: vi.fn(() => options.windowDestroyed ?? false),
    webContents: {
      isDestroyed: vi.fn(() => options.contentsDestroyed ?? false),
      isCrashed: vi.fn(() => options.contentsCrashed ?? false),
    },
  };
}

describe('availableRendererWindows', () => {
  it('keeps only live windows with messageable renderer contents', () => {
    const available = rendererWindow();
    const destroyedWindow = rendererWindow({ windowDestroyed: true });
    const destroyedContents = rendererWindow({ contentsDestroyed: true });
    const crashedContents = rendererWindow({ contentsCrashed: true });

    expect(availableRendererWindows([
      null,
      available,
      destroyedWindow,
      destroyedContents,
      crashedContents,
    ])).toEqual([available]);
  });
});
