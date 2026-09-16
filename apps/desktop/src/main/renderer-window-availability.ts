interface RendererWebContents {
  isDestroyed(): boolean;
  isCrashed(): boolean;
}

interface RendererWindow {
  isDestroyed(): boolean;
  readonly webContents: RendererWebContents;
}

/**
 * Keeps main-process broadcasts away from windows whose renderer can no longer
 * receive IPC. BrowserWindow lifetime and renderer lifetime are independent:
 * after a crash the native window still exists while its WebContents is gone.
 */
export function availableRendererWindows<T extends RendererWindow>(
  windows: readonly (T | null)[],
): T[] {
  return windows.filter((window): window is T => Boolean(
    window
      && !window.isDestroyed()
      && !window.webContents.isDestroyed()
      && !window.webContents.isCrashed(),
  ));
}
