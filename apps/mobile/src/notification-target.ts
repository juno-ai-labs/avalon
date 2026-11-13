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
  url.searchParams.set('mobile', '1');
  return { url: url.href, external: false };
}
