import { expect, it } from 'vitest';
import { dashboardVisible } from './dashboard-visibility';

const base = { home: true, chatOpen: false, opening: false, snapshot: null, hasDirectory: true };

it('draws the saved dashboard before Home answers, and nothing without a directory', () => {
  expect(dashboardVisible(base)).toBe(true);
  expect(dashboardVisible({ ...base, hasDirectory: false })).toBe(false);
});

it('follows the page once it answers', () => {
  expect(dashboardVisible({ ...base, snapshot: { view: 'home' } })).toBe(true);
  expect(dashboardVisible({ ...base, snapshot: { view: 'artifact' } })).toBe(false);
  expect(dashboardVisible({ ...base, snapshot: { view: 'create' } })).toBe(false);
});

it('steps aside for an opening canvas, an inline chat, and other tabs', () => {
  expect(dashboardVisible({ ...base, snapshot: { view: 'home' }, opening: true })).toBe(false);
  expect(dashboardVisible({ ...base, snapshot: { view: 'home' }, chatOpen: true })).toBe(false);
  expect(dashboardVisible({ ...base, home: false })).toBe(false);
});
