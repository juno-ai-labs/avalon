import { describe, expect, it } from 'vitest';
import type { Message } from '../lib/types';
import { conversationExportTurns } from './conversation-export';

function message(overrides: Partial<Message>): Message {
  return {
    id: overrides.id ?? 'm',
    workstreamId: 'w1',
    sequenceNumber: 1,
    authorType: 'agent',
    messageType: 'text',
    createdAt: '2026-10-24T15:04:00.000Z',
    ...overrides,
  };
}

describe('the turns a conversation export prints', () => {
  it('keeps what was said, in order, named as the feed names it', () => {
    const turns = conversationExportTurns([
      message({ id: 'a', authorType: 'human', author: { id: 'u1', name: 'Maya' }, text: 'Where are we on pricing?' }),
      message({ id: 'b', messageType: 'thought', text: 'Thinking about tiers' }),
      message({ id: 'c', messageType: 'tool_event', text: 'search' }),
      message({ id: 'd', text: 'Two tiers are **settled**.' }),
      message({ id: 'e', authorType: 'system', messageType: 'system', text: 'Theo joined' }),
      message({ id: 'f', messageType: 'automation_activation', automationActivation: { automationId: 's1', automationName: 'Weekly digest' }, text: 'Digest' }),
      message({ id: 'g', authorType: 'external', externalActor: { displayName: 'Priya' } as Message['externalActor'], text: 'From Slack' }),
      message({ id: 'h', text: '   ' }),
      message({ id: 'i', authorType: 'human', author: { id: 'u1', name: 'Maya' }, text: 'Not sent yet', deliveryState: 'sending' }),
    ]);
    expect(turns.map(({ id, author, human, text }) => ({ id, author, human, text }))).toEqual([
      { id: 'a', author: 'Maya', human: true, text: 'Where are we on pricing?' },
      { id: 'd', author: 'Rally', human: false, text: 'Two tiers are **settled**.' },
      { id: 'f', author: 'Weekly digest', human: false, text: 'Digest' },
      { id: 'g', author: 'Priya · Slack', human: true, text: 'From Slack' },
    ]);
  });
});
