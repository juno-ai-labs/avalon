import { describe, expect, it } from 'vitest';

import { sidekickSourceRequestCardFromToolEvent } from './sidekick-source-request-card';

const SIDEKICK = '00000000-0000-7000-8000-0000000000d1';
const MAYA = '00000000-0000-7000-8000-0000000000a3';
const FIRST = '00000000-0000-7000-8000-0000000000e1';
const SECOND = '00000000-0000-7000-8000-0000000000e2';

const view = (requestId: string) => ({
  requestId, sidekickId: SIDEKICK, sidekickName: 'Deals', person: { userId: MAYA, displayName: 'Maya' },
  connectorType: 'google', eventTypes: ['email.received'], condition: null, state: 'pending',
  requestedByName: 'Adam', yours: false, createdAt: 1, decidedAt: null,
});

describe('the card a source request tool call draws', () => {
  it('reads which requests to show from a completed call\'s output, and keeps the output to paint first', () => {
    const output = { sidekickId: SIDEKICK, requests: [view(FIRST), view(SECOND)] };
    expect(sidekickSourceRequestCardFromToolEvent({ name: 'sidekick_request_source', status: 'completed', output })).toEqual({
      sidekickId: SIDEKICK, requestIds: [FIRST, SECOND], asked: [view(FIRST), view(SECOND)],
    });
  });

  it('draws from the ids alone when the rest of the output is not a request this client knows', () => {
    // A live row carries the activity's prose as its name and the tool's own under `wireName`.
    expect(sidekickSourceRequestCardFromToolEvent({
      name: 'Asking for a source', wireName: 'sidekick_request_source', status: 'completed',
      output: { sidekickId: SIDEKICK, requests: [{ requestId: FIRST, state: 'a state from a newer server' }] },
    })).toEqual({ sidekickId: SIDEKICK, requestIds: [FIRST], asked: null });
  });

  it('draws nothing for another tool, a call that has not completed, or an output with no request to read', () => {
    const output = { sidekickId: SIDEKICK, requests: [view(FIRST)] };
    expect(sidekickSourceRequestCardFromToolEvent({ name: 'sidekick_read_sources', status: 'completed', output })).toBeNull();
    expect(sidekickSourceRequestCardFromToolEvent({ name: 'sidekick_request_source', status: 'started' })).toBeNull();
    expect(sidekickSourceRequestCardFromToolEvent({ name: 'sidekick_request_source', status: 'failed', output })).toBeNull();
    expect(sidekickSourceRequestCardFromToolEvent({ name: 'sidekick_request_source', status: 'completed', output: 'Asked 2 people' })).toBeNull();
    expect(sidekickSourceRequestCardFromToolEvent({ name: 'sidekick_request_source', status: 'completed', output: { sidekickId: SIDEKICK, requests: [] } })).toBeNull();
    expect(sidekickSourceRequestCardFromToolEvent(undefined)).toBeNull();
  });
});
