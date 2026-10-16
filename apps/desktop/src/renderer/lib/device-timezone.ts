import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { UserTimezone } from '@rally/contracts';

import type { RallyApi } from './api';

export const MY_TIMEZONE_QUERY_KEY = ['my-timezone'] as const;

/** The zone this device is in, or null where the runtime cannot say. */
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Tells the server which zone this device is in, at launch and whenever the
 * window regains focus, so a person who follows their device (Settings →
 * Account → Set timezone automatically) has digests in the day they are
 * actually in. The server ignores it for a fixed zone, and writes nothing
 * when the zone has not moved.
 *
 * Sent every time rather than only when this device's zone changes: another
 * device may have moved the account since, and the device in use is the one
 * that should win. The request is fire-and-forget, off every rendering path.
 */
export function useDeviceTimezoneSync(
  api: Pick<RallyApi, 'reportDeviceTimezone'> | null,
  enabled: boolean,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!api || !enabled) return;
    // An account switch clears the cache and remounts this; a report that
    // lands after that belongs to the previous account.
    let active = true;
    const report = () => {
      const zone = deviceTimezone();
      if (!zone) return;
      void api.reportDeviceTimezone(zone).then((state) => {
        if (!active) return;
        const before = queryClient.getQueryData<UserTimezone>(MY_TIMEZONE_QUERY_KEY);
        queryClient.setQueryData(MY_TIMEZONE_QUERY_KEY, state);
        // The digest names the zone it runs in.
        if (before?.timezone !== state.timezone) void queryClient.invalidateQueries({ queryKey: ['digest-schedule'] });
      }, () => undefined);
    };
    report();
    window.addEventListener('focus', report);
    return () => {
      active = false;
      window.removeEventListener('focus', report);
    };
  }, [api, enabled, queryClient]);
}
