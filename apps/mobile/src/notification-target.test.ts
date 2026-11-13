import { expect, it } from 'vitest';
import { notificationTarget } from './notification-target';
import { canvasCanonicalUrl, sidekickCanonicalUrl } from '@rally/contracts/links';

const app = 'https://app.rallywith.ai';
const workspaceId = '00000000-0000-4000-8000-000000000001';
const canvasId = '00000000-0000-4000-8000-000000000002';
const turnId = '00000000-0000-4000-8000-000000000003';
const url = canvasCanonicalUrl('https://rallywith.ai', { region: 'global', workspaceId, canvasId, turnId, sequence: 7 });
const notice = { v: 1, kind: 'mention', region: 'global', workspaceId, url };

it('opens a canvas notification in the cookie-authenticated app and preserves its message target', () => {
  const result = notificationTarget({ rally: notice }, app);
  expect(result?.external).toBe(false);
  const opened = new URL(result!.url);
  expect(opened.origin).toBe(app);
  expect(opened.searchParams.get('turn')).toBe(turnId);
  expect(opened.searchParams.get('sequence')).toBe('7');
  expect(opened.searchParams.get('mobile')).toBe('1');
  expect(opened.pathname).toBe(new URL(url).pathname);
});
it('rejects foreign origins, mismatched organization context, and malformed payloads', () => {
  expect(notificationTarget({ rally: { ...notice, url: url.replace('rallywith.ai', 'evil.example') } }, app)).toBeNull();
  expect(notificationTarget({ rally: { ...notice, workspaceId: canvasId } }, app)).toBeNull();
  expect(notificationTarget({ rally: { ...notice, v: 99 } }, app)).toBeNull();
  expect(notificationTarget({ url }, app)).toBeNull();
});
it('opens Sidekick notices on their canonical web surface', () => {
  const sidekick = sidekickCanonicalUrl('https://rallywith.ai', { region: 'global', workspaceId, sidekickId: canvasId });
  expect(notificationTarget({ rally: { ...notice, url: sidekick } }, app)).toEqual({ url: sidekick, external: true });
});
