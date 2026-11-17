import type { ActivityItem } from '@rally/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { sidekicksWithMovedSourceRequests, sourceRefusal, sourceWords } from './sidekick-sources';

describe('what a source\'s connector and events are called', () => {
  it('names Google by the product its events belong to, and any other connector as its mention does', () => {
    expect(sourceWords({ connectorType: 'google', eventTypes: ['email.received'] })).toEqual({ connector: 'Gmail', events: 'Email received' });
    expect(sourceWords({ connectorType: 'google', eventTypes: ['calendar.event_changed', 'calendar.event_completed'] }))
      .toEqual({ connector: 'Google Calendar', events: 'Calendar event changed, Calendar event completed' });
    expect(sourceWords({ connectorType: 'google', eventTypes: ['drive.file_changed', 'docs.document_changed'] }).connector).toBe('Google Drive');
    expect(sourceWords({ connectorType: 'google', eventTypes: ['email.received', 'calendar.event_changed'] }).connector).toBe('Google');
    expect(sourceWords({ connectorType: 'github', eventTypes: ['github.pull_request.opened'] })).toEqual({ connector: 'GitHub', events: 'Pull request opened' });
    // A connector this client has no card for keeps its own type.
    expect(sourceWords({ connectorType: 'acme_crm', eventTypes: ['deal'] })).toEqual({ connector: 'acme_crm', events: 'Deal' });
  });
});

describe('why an answer was refused', () => {
  const ask = { connectorType: 'google', eventTypes: ['email.received'] };

  it('tells a person approving with nothing connected which account to connect', () => {
    expect(sourceRefusal(new ApiError('nothing connected', 409, 'sidekick_source_connection_missing'), ask))
      .toBe('Connect your Gmail account first. There is nothing to allow until it is connected.');
  });

  it('tells a person approving with a lapsed sign-in which account to reconnect', () => {
    expect(sourceRefusal(new ApiError('lapsed', 409, 'sidekick_source_connection_reconnect'), ask))
      .toBe('Reconnect your Gmail account first. Its sign-in has lapsed, so nothing could arrive from it.');
  });

  it('says each refusal the contract names in the contract\'s words, and anything else in the server\'s', () => {
    expect(sourceRefusal(new ApiError('x', 403, 'sidekick_source_request_not_yours'), ask)).toBe('Only the person asked can answer this request.');
    expect(sourceRefusal(new ApiError('x', 409, 'sidekick_source_request_settled'), ask)).toBe('This request was already answered.');
    expect(sourceRefusal(new ApiError('The Organization is being moved.', 503, 'workstream_maintenance'), ask)).toBe('The Organization is being moved.');
    expect(sourceRefusal(new Error('Failed to fetch'))).toBe('Failed to fetch');
  });
});

describe('which Sidekicks an Activity push moved a source request of', () => {
  const row = (id: string, sidekickId: string, state: 'pending' | 'approved' | 'declined' | 'cancelled' | null): ActivityItem => ({
    id, kind: state === null ? 'mention' : 'source_request', parentKind: 'automation', parentId: sidekickId, parentTitle: 'Deals',
    substreamId: '0', messageId: null, messageSequence: null, runId: null, actor: { kind: 'person', id: null }, preview: null,
    createdAt: '2026-11-10T09:00:00.000Z', seen: false,
    ...(state === null ? {} : { sourceRequest: {
      requestId: `request-${id}`, state, connectorType: 'google', eventTypes: ['email.received'], condition: null,
      requestedByName: 'Adam', personName: null,
    } }),
  } as ActivityItem);

  it('names a Sidekick whose request was answered, arrived or left, and no other', () => {
    const before = [row('a', 'deals', 'pending'), row('b', 'digest', 'pending'), row('c', 'triage', 'pending'), row('m', 'notes', null)];
    const after = [
      row('a', 'deals', 'approved'), // answered
      row('b', 'digest', 'pending'), // untouched
      row('d', 'hiring', 'pending'), // newly asked; `c` left the page
      row('m', 'notes', null),
      row('n', 'notes', null), // a mention is no source request
    ];
    expect(sidekicksWithMovedSourceRequests(before, after).sort()).toEqual(['deals', 'hiring', 'triage']);
    expect(sidekicksWithMovedSourceRequests(after, after)).toEqual([]);
  });
});
