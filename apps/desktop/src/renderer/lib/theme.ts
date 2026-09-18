import { applyTheme, readThemeChoice, setThemeReporter } from '@rally/ui/lib/theme';
import { parseThemeChoice } from '../../common/themes';
import { desktopBridge, desktopServicesAvailable } from './platform';
export * from '@rally/ui/lib/theme';
setThemeReporter((choice) => {
  if (desktopServicesAvailable()) void desktopBridge().setWindowTheme(choice).catch(() => undefined);
});
export function watchThemeBroadcast(): () => void {
  if (!desktopServicesAvailable()) return () => undefined;
  return desktopBridge().onThemeChanged((choice) => applyTheme(parseThemeChoice(choice) ?? readThemeChoice()));
}
