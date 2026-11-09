import { describe, expect, it, vi } from 'vitest';

import { formatNextRun, sidekickNext } from './sidekick-status';

describe('sidekickNext', () => {
  const now = new Date('2026-11-08T12:00:00');
  it('says what wakes it, alert before email before a schedule\'s next run before request', () => {
    expect(sidekickNext({ status: 'active', nextRunAt: '2026-11-13T14:00:00', triggerKinds: ['schedule', 'manual'] }, now)).toMatch(/^Fri.*2:00/);
    // Design §3's Incident triage: an alert and a schedule read "On alert".
    expect(sidekickNext({ status: 'active', nextRunAt: '2026-11-13T14:00:00', triggerKinds: ['schedule', 'external_event'] }, now)).toBe('On alert');
    expect(sidekickNext({ status: 'active', nextRunAt: '2026-11-13T14:00:00', triggerKinds: ['schedule', 'inbound_email'] }, now)).toBe('On email');
    expect(sidekickNext({ status: 'active', triggerKinds: ['manual', 'inbound_email', 'external_event'] }, now)).toBe('On alert');
    expect(sidekickNext({ status: 'active', triggerKinds: ['manual', 'inbound_email'] }, now)).toBe('On email');
    expect(sidekickNext({ status: 'active', triggerKinds: ['manual'] }, now)).toBe('On request');
  });

  it('says nothing is next for a Sidekick that is not running, or that nothing wakes', () => {
    expect(sidekickNext({ status: 'paused', nextRunAt: '2026-11-13T14:00:00', triggerKinds: ['schedule'] }, now)).toBe('—');
    expect(sidekickNext({ status: 'active', triggerKinds: [] }, now)).toBe('—');
  });
});

describe('formatNextRun', () => {
  // 22:00 UTC on Friday 13 November 2026 is 2:00 PM that day in Los Angeles.
  const next = '2026-11-13T22:00:00.000Z';
  const now = new Date('2026-11-08T12:00:00.000Z');

  it('says the time in the schedule\'s own zone, so every machine reads the time the schedule says', () => {
    expect(formatNextRun(next, 'long', now, 'America/Los_Angeles')).toMatch(/^Friday,? 2:00\sPM$/);
    expect(formatNextRun(next, 'short', now, 'Asia/Tokyo')).toMatch(/^Sat,? 7:00\sAM$/);
    expect(sidekickNext({ status: 'active', nextRunAt: next, scheduleTimeZone: 'America/Los_Angeles', triggerKinds: ['schedule'] }, now))
      .toMatch(/^Fri,? 2:00\sPM$/);
  });

  it('falls back to the machine\'s zone without a zone, or with one it does not know', () => {
    // The machine's zone pinned, so the fallback is checked against a literal.
    vi.stubEnv('TZ', 'Asia/Tokyo');
    try {
      expect(formatNextRun(next, 'long', now)).toMatch(/^Saturday,? 7:00\sAM$/);
      expect(formatNextRun(next, 'long', now, 'Not/AZone')).toMatch(/^Saturday,? 7:00\sAM$/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
