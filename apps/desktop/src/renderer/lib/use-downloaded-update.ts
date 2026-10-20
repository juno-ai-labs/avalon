import { useEffect, useMemo, useState } from 'react';
import { desktopBridge } from './platform';
import type { DesktopUpdateStatus } from '../../common/desktop';

/**
 * The version of an update the main process has downloaded and can install on
 * restart, or null while none is ready. Status changes reach every window
 * through the `update:status-changed` broadcast.
 */
export function useDownloadedUpdate(): string | null {
  const status = useUpdateStatus();
  return status?.kind === 'downloaded' ? status.version : null;
}

/** The updater's live state, shared by restart and progress affordances. */
export function useUpdateStatus(enabled = true): DesktopUpdateStatus | null {
  const bridge = useMemo(() => desktopBridge(), []);
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Invoke replies and live events use independent Electron channels. Once a
    // live transition arrives, the pending mount-time read is obsolete.
    let liveUpdateGeneration = 0;
    const unsubscribe = bridge.onUpdateStatusChanged((status) => {
      liveUpdateGeneration += 1;
      if (!cancelled) setStatus(status);
    });
    const generationAtRead = liveUpdateGeneration;
    void bridge.getUpdateStatus()
      .then((status) => {
        if (!cancelled && liveUpdateGeneration === generationAtRead) {
          setStatus(status);
        }
      })
      // The restart affordance stays hidden when the status is unreadable.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge, enabled]);

  return enabled ? status : null;
}
