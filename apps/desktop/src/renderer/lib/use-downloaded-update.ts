import { useEffect, useMemo, useState } from 'react';
import { desktopBridge } from './platform';

/**
 * The version of an update the main process has downloaded and can install on
 * restart, or null while none is ready. Status changes reach every window
 * through the `update:status-changed` broadcast.
 */
export function useDownloadedUpdate(): string | null {
  const bridge = useMemo(() => desktopBridge(), []);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Invoke replies and live events use independent Electron channels. Once a
    // live transition arrives, the pending mount-time read is obsolete.
    let liveUpdateGeneration = 0;
    const unsubscribe = bridge.onUpdateStatusChanged((status) => {
      liveUpdateGeneration += 1;
      if (!cancelled) setVersion(status.kind === 'downloaded' ? status.version : null);
    });
    const generationAtRead = liveUpdateGeneration;
    void bridge.getUpdateStatus()
      .then((status) => {
        if (!cancelled && liveUpdateGeneration === generationAtRead) {
          setVersion(status.kind === 'downloaded' ? status.version : null);
        }
      })
      // The restart affordance stays hidden when the status is unreadable.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  return version;
}
