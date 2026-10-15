import { describe, expect, it } from 'vitest';

import type { DigestSchedule } from '../lib/types';
import { draftFromSchedule, minutesToLabel, scheduleFromDraft } from './notification-settings';

const stored = (patch: Partial<DigestSchedule>): DigestSchedule => ({
  id: '00000000-0000-4000-8000-000000000001',
  enabled: true,
  days: [1, 2, 3, 4, 5],
  times: [9 * 60],
  timezone: 'Europe/London',
  deliveryTargets: [{ type: 'email', connectionId: null, displayName: 'you@example.test', status: 'active', lastDeliveredAt: null }],
  nextRunAt: null,
  lastDeliveredAt: null,
  ...patch,
});

describe('the daily digest slots', () => {
  it('reads the first time before noon as the start of the day and the first after it as the end', () => {
    expect(draftFromSchedule(stored({ times: [9 * 60, 17.5 * 60] }))).toMatchObject({ morning: 540, evening: 1050 });
    expect(draftFromSchedule(stored({ times: [17 * 60] }))).toMatchObject({ morning: null, evening: 1020 });
  });

  it('reads a digest someone switched off as both slots off, and one with nowhere to go as still on', () => {
    expect(draftFromSchedule(stored({ enabled: false }))).toMatchObject({ morning: null, evening: null });
    expect(draftFromSchedule(stored({ enabled: false, deliveryTargets: [] }))).toMatchObject({ morning: 540 });
  });

  it('saves the slots that are on as its times, and nothing on or nowhere to send it as switched off', () => {
    const targets = [{ type: 'personal_channel' as const, connectionId: null }];
    expect(scheduleFromDraft({ morning: 540, evening: 1050, days: [1], targets }))
      .toEqual({ enabled: true, days: [1], times: [540, 1050], deliveryTargets: targets });
    expect(scheduleFromDraft({ morning: null, evening: null, days: [1], targets })).toMatchObject({ enabled: false, times: [] });
    expect(scheduleFromDraft({ morning: 540, evening: null, days: [1], targets: [] })).toMatchObject({ enabled: false, times: [540] });
  });

  it('labels a time of day as the menu shows it', () => {
    expect([minutesToLabel(9 * 60), minutesToLabel(17.5 * 60), minutesToLabel(12 * 60)]).toEqual(['9:00 AM', '5:30 PM', 'Noon']);
  });
});
