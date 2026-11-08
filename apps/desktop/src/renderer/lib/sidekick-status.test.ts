import { describe, expect, it } from 'vitest';

import { sidekickNext } from './sidekick-status';

describe('sidekickNext', () => {
  const now = new Date('2026-11-08T12:00:00');
  it('says when a schedule next runs, and otherwise what wakes it, alert before email before request', () => {
    expect(sidekickNext({ status: 'active', nextRunAt: '2026-11-13T14:00:00', triggerKinds: ['schedule', 'manual'] }, now)).toMatch(/^Fri.*2:00/);
    expect(sidekickNext({ status: 'active', triggerKinds: ['manual', 'inbound_email', 'external_event'] }, now)).toBe('On alert');
    expect(sidekickNext({ status: 'active', triggerKinds: ['manual', 'inbound_email'] }, now)).toBe('On email');
    expect(sidekickNext({ status: 'active', triggerKinds: ['manual'] }, now)).toBe('On request');
  });

  it('says nothing is next for a Sidekick that is not running, or that nothing wakes', () => {
    expect(sidekickNext({ status: 'paused', nextRunAt: '2026-11-13T14:00:00', triggerKinds: ['schedule'] }, now)).toBe('—');
    expect(sidekickNext({ status: 'active', triggerKinds: [] }, now)).toBe('—');
  });
});
