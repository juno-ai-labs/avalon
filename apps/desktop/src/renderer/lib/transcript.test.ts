import { describe, expect, it } from 'vitest';
import type { Message } from './types';
import {
  continuedAgentTurns,
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

  it('groups the rows of one agent turn and starts a new one after anybody else speaks', () => {
    const agent = (id: string, sequenceNumber: number): Message =>
      createTextMessage({ ...base, id, sequenceNumber, authorType: 'agent', text: id });
    const tool = (id: string, sequenceNumber: number): Message => createToolEventMessage({
      ...base,
      id,
      sequenceNumber,
      authorType: 'agent',
      toolEvent: { id, name: 'Search', status: 'completed' },
    });
    const human = (id: string, sequenceNumber: number): Message =>
      createTextMessage({ ...base, id, sequenceNumber, authorType: 'human', text: id });

    const grouped = continuedAgentTurns([
      human('asked', 1),
      agent('said', 2),
      tool('ran', 3),
      agent('said-again', 4),
      human('replied', 5),
      agent('answered', 6),
    ]);

    // The work between two things the run said is its own; a person speaking
    // between them is not.
    expect([...grouped]).toEqual(['said-again']);
  });
});
