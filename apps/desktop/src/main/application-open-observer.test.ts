import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationOpenObserver,
  initialApplicationOpenEntrypoint,
} from './application-open-observer';

afterEach(() => vi.useRealTimers());

describe('application-open attribution', () => {
  it('classifies only provable cold-start sources', () => {
    expect(initialApplicationOpenEntrypoint({ openedAtLogin: false, hasDeepLink: false, hasPushNotification: true })).toBe('push_notification');
    expect(initialApplicationOpenEntrypoint({ openedAtLogin: true, hasDeepLink: false }))
      .toBe('system_start');
    expect(initialApplicationOpenEntrypoint({ openedAtLogin: false, hasDeepLink: true }))
      .toBe('deep_link');
    expect(initialApplicationOpenEntrypoint({ openedAtLogin: false, hasDeepLink: false }))
      .toBe('user_launch');
  });

  it('reports one cold start and suppresses its matching activate callback', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const observer = new ApplicationOpenObserver(report);

    observer.launched('system_start');
    observer.activated();
    vi.runAllTimers();

    expect(report.mock.calls).toEqual([['system_start', 'cold_start']]);
  });

  it.each(['menu_bar', 'deep_link', 'push_notification'] as const)(
    'prefers explicit %s attribution when activate arrives on either side',
    (entrypoint) => {
      vi.useFakeTimers();
      const report = vi.fn();
      const observer = new ApplicationOpenObserver(report);

      observer.activated();
      observer.opened(entrypoint);
      vi.runAllTimers();
      observer.opened(entrypoint);
      observer.activated();
      vi.runAllTimers();

      expect(report.mock.calls).toEqual([
        [entrypoint, 'activation'],
        [entrypoint, 'activation'],
      ]);
    },
  );

  it('reports an otherwise unattributed activate callback as Dock', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const observer = new ApplicationOpenObserver(report);

    observer.activated();
    vi.runAllTimers();

    expect(report.mock.calls).toEqual([['dock', 'activation']]);
  });
});
