import { useEffect, useMemo, useState } from 'react';
import { desktopBridge } from './platform';

/**
 * Reads Application → Developer → **Debug enabled**, as it is in effect rather
 * than as it is stored: the main process reports the stored preference only
 * while the service's `developer-settings` flag stands behind it, so a surface
 * reading this can never reveal a debugging affordance the account is not
 * entitled to. The gate lives there rather than here so every reader inherits
 * it — see `docs/feature-flags.md`.
 *
 * The preference lives in the main process, so a change made in the Settings
 * window — or a poll that finds the flag withdrawn — reaches the main window
 * through the application-settings broadcast rather than a reload.
 */
export function useDebugEnabled(): boolean {
  const bridge = useMemo(() => desktopBridge(), []);
  const [debugEnabled, setDebugEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Main announces transitions, not the current value on every poll. Once a
    // live transition arrives, the older mount-time read must never replace it.
    let liveUpdateGeneration = 0;
    const unsubscribe = bridge.onApplicationSettingsChanged((settings) => {
      liveUpdateGeneration += 1;
      if (!cancelled) setDebugEnabled(settings.debugEnabled);
    });
    const generationAtRead = liveUpdateGeneration;
    void bridge.getApplicationSettings()
      .then((settings) => {
        if (!cancelled && liveUpdateGeneration === generationAtRead) {
          setDebugEnabled(settings.debugEnabled);
        }
      })
      // Debugging affordances stay hidden when the preference is unreadable;
      // there is nothing here worth interrupting the surface for.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  return debugEnabled;
}
