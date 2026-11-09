import { useEffect } from 'react';

import { desktopBridge } from './platform';

/**
 * Keeps the dock badge, or an installed browser app's icon badge, on the
 * rail's counts added up (`useSectionCounts`) while the shell is mounted, and
 * clears it when the shell goes (sign-out, a switch of Organization). APNs and
 * Web Push set a number while Rally is not running
 * (`docs/push-notifications.md`).
 *
 * `complete` says the count is whole: both lists it reads have arrived. A
 * count from a half-loaded list would lower the badge APNs last set, so
 * nothing is sent until then.
 */
export function useDockBadge(count: number, complete: boolean): void {
  useEffect(() => {
    if (!complete) return;
    void desktopBridge().setDockBadgeCount(count).catch(() => undefined);
  }, [count, complete]);
  useEffect(() => () => {
    void desktopBridge().setDockBadgeCount(0).catch(() => undefined);
  }, []);
}
