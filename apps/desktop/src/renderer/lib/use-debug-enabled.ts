import { useEffect, useMemo, useState } from 'react';
import { desktopBridge } from './platform';

/**
 * Reads Application → Developer → **Debug enabled**. The preference lives in
 * the main process, so a change made in the Settings window reaches the main
 * window through the application-settings broadcast rather than a reload.
 */
export function useDebugEnabled(): boolean {
  const bridge = useMemo(() => desktopBridge(), []);
  const [debugEnabled, setDebugEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bridge.getApplicationSettings()
      .then((settings) => {
        if (!cancelled) setDebugEnabled(settings.debugEnabled);
      })
      // Debugging affordances stay hidden when the preference is unreadable;
      // there is nothing here worth interrupting the surface for.
      .catch(() => undefined);
    const unsubscribe = bridge.onApplicationSettingsChanged((settings) => {
      if (!cancelled) setDebugEnabled(settings.debugEnabled);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  return debugEnabled;
}
