import { describe, expect, it } from 'vitest';
import type { Message } from './types';
import {
  createElicitationMessage,
  createTextMessage,
  createToolEventMessage,
  removeTranscriptMessage,
  upsertTranscriptMessage,
} from './transcript';

const base = {
  id: 'message-one',
  workstreamId: 'workstream-one',
  sequenceNumber: 1,
  authorType: 'agent' as const,
  createdAt: '2026-08-05T12:00:00.000Z',
};

describe('transcript messages', () => {
  it('creates text, tool, and elicitation messages from the same base shape', () => {
    expect(createTextMessage({ ...base, text: 'Hello' })).toMatchObject({ messageType: 'text', text: 'Hello' });
    expect(createToolEventMessage({
      ...base,
      toolEvent: { id: 'tool-one', name: 'Search', status: 'started' },
    })).toMatchObject({ messageType: 'tool_event', toolEvent: { id: 'tool-one' } });
    expect(createElicitationMessage({
      ...base,
      elicitation: { id: 'question-one', prompt: 'Choose', responseType: 'single_select', status: 'open' },
    })).toMatchObject({ messageType: 'elicitation', elicitation: { id: 'question-one' } });
  });

  it('replaces logical client and persisted messages without moving their transcript position', () => {
    const optimistic = createTextMessage({
      ...base,
      id: 'client-one',
      clientMessageId: 'client-one',
      authorType: 'human',
      text: 'Hello',
    });
    const trailing = createTextMessage({ ...base, id: 'message-two', sequenceNumber: 2, text: 'After' });
    const persisted: Message = { ...optimistic, id: 'persisted-one', deliveryState: undefined };

    expect(upsertTranscriptMessage([optimistic, trailing], persisted)).toEqual([persisted, trailing]);
    expect(removeTranscriptMessage([persisted, trailing], persisted.id)).toEqual([trailing]);
  });
});
