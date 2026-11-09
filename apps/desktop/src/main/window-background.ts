import { resolveTheme, themeWindowBackground, type ThemeChoice } from '../common/themes';

/** The part of a `BrowserWindow` a repaint needs. */
export type BackgroundWindow = { isDestroyed(): boolean; setBackgroundColor(color: string): void };

/**
 * Repaint every window's native background for the appearance a choice
 * resolves to now.
 *
 * A window takes its background when it is constructed, and that colour is
 * what shows wherever the document has not painted: a live resize on macOS,
 * the frame before a reload paints. Changing the appearance repaints the
 * document but not the window, so without this a dark app keeps a light edge
 * until it is reopened, and the same the other way round.
 */
export function repaintWindowBackgrounds(windows: Iterable<BackgroundWindow>, choice: ThemeChoice, systemDark: boolean): void {
  const color = themeWindowBackground[resolveTheme(choice, systemDark)];
  for (const window of windows) {
    if (!window.isDestroyed()) window.setBackgroundColor(color);
  }
}
