import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

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
 * Account → Set timezone automatically) has digests and automations in the
 * day they are actually in. The server ignores it for a fixed zone.
 *
 * Sent only when the zone differs from the last one this device sent for this
 * person, so an ordinary launch costs no request. A failed send is retried on
 * the next focus because nothing is remembered until it lands.
 */
export function useDeviceTimezoneSync(
  api: Pick<RallyApi, 'reportDeviceTimezone'> | null,
  userId: string,
  enabled: boolean,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!api || !enabled) return;
    const key = `rally.device-timezone.${userId}`;
    const report = () => {
      const zone = deviceTimezone();
      if (!zone) return;
      let last: string | null = null;
      try { last = window.localStorage.getItem(key); } catch { /* storage unavailable: send */ }
      if (last === zone) return;
      void api.reportDeviceTimezone(zone).then((state) => {
        try { window.localStorage.setItem(key, zone); } catch { /* sent again next focus */ }
        queryClient.setQueryData(MY_TIMEZONE_QUERY_KEY, state);
      }, () => undefined);
    };
    report();
    window.addEventListener('focus', report);
    return () => window.removeEventListener('focus', report);
  }, [api, enabled, queryClient, userId]);
}
