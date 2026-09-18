import { applyTheme, readThemeChoice, setThemeReporter } from '@rally/ui/lib/theme';
import { parseThemeChoice } from '../../common/themes';
import { desktopBridge, desktopServicesAvailable } from './platform';
export * from '@rally/ui/lib/theme';
setThemeReporter((choice) => {
  if (desktopServicesAvailable()) void desktopBridge().setWindowTheme(choice).catch(() => undefined);
});
/**
 * Follows a theme chosen in another window.
 *
 * Every window reads the same stored preference, but each holds its own
 * document, so a choice made in the Settings window would otherwise repaint only
 * the Settings window.
 *
 * The payload is applied rather than the store re-read. Both carry the choice,
 * so `system` still re-resolves against *this* window's `matchMedia` either way
 * — but each window is its own renderer process, and a `localStorage` write in
 * the Settings renderer is not ordered against an IPC round trip through main.
 * A window that re-read a store the write had not reached yet would re-apply the
 * *old* choice and report it back, main would see a difference and broadcast
 * again, and the guard that stops the echo would instead be driving one. It
 * settles once storage propagates; what it looks like in the meantime is a
 * flicker across windows.
 *
 * A payload this build cannot read falls back to the store, which is the only
 * other thing that could be meant.
 */

export function watchThemeBroadcast(): () => void {
  if (!desktopServicesAvailable()) return () => undefined;
  return desktopBridge().onThemeChanged((choice) => applyTheme(parseThemeChoice(choice) ?? readThemeChoice()));
}
