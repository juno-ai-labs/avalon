import type { NotificationRequest } from 'expo-notifications';
import { parseLinkTarget } from '@rally/contracts/links';
import { PushNotificationDataSchema } from '@rally/contracts/push-notifications';

/** Push payloads are routing hints; the ordinary browser session authorizes the target. */
export function notificationTarget(data: unknown, appUrl: string): { url: string; external: boolean } | null {
  if (!data || typeof data !== 'object' || !('rally' in data)) return null;
  const parsed = PushNotificationDataSchema.safeParse(data.rally);
  if (!parsed.success) return null;
  const notice = parsed.data;
  const target = parseLinkTarget(notice.url, { webBaseUrl: 'https://rallywith.ai' });
  if (!target || target.region !== notice.region || target.workspaceId !== notice.workspaceId) return null;
  if (target.kind !== 'canvas') return { url: notice.url, external: true };
  const canonical = new URL(notice.url);
  const url = new URL(canonical.pathname + canonical.search, appUrl);
  return { url: url.href, external: false };
}

/** Direct APNs userInfo is on Expo's push trigger; local notifications use data. */
export function notificationPayload(trigger: NotificationRequest['trigger'], data: unknown): unknown {
  return trigger && 'type' in trigger && trigger.type === 'push' && trigger.payload ? trigger.payload : data;
}
