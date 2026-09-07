import { describe, expect, it } from 'vitest';
import { teammatesFromCalendarPage } from '../src/services/onboarding-teammates';

describe('meeting-based teammate suggestions', () => {
  it('counts distinct shared meetings and excludes existing, self, declined and cancelled attendees', () => {
    const attendees = [{ email: 'me@example.com', self: true }, { email: 'member@example.com', displayName: null, responseStatus: null },
      { email: 'NEW@example.com', displayName: 'New teammate' }, { email: 'no@example.com', responseStatus: 'declined' }, { email: null, displayName: null, responseStatus: null }];
    const result = teammatesFromCalendarPage({ items: [
      { id: 'first', attendees, summary: 'Private title', description: 'Private content' },
      { id: 'first', attendees }, { id: 'second', attendees, attendeesOmitted: true },
      { id: 'cancelled', status: 'cancelled', attendees: [{ email: 'cancel@example.com' }] },
      { id: 'declined', attendees: [{ email: 'me@example.com', self: true, responseStatus: 'declined' }, { email: 'other@example.com' }] },
    ], nextPageToken: 'next' }, new Set(['member@example.com']));
    expect(result).toEqual({ items: [{ email: 'new@example.com', name: 'New teammate', meetings: ['first', 'second'] }], nextPageToken: 'next', partial: true });
  });
});
