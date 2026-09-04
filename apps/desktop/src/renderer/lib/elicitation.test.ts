import { describe, expect, it, vi } from 'vitest';
import type { Message } from './types';
import {
  answerElicitationOptimistically,
  elicitationMessageId,
  normalizeElicitation,
} from './elicitation';

const openMessage: Message = {
  id: 'message-question',
  workstreamId: 'workstream-one',
  sequenceNumber: 1,
  authorType: 'agent',
  messageType: 'elicitation',
  createdAt: '2026-08-05T12:00:00.000Z',
  elicitation: {
    id: 'question-one',
    prompt: 'Where should the draft go?',
    responseType: 'single_select',
    options: [{ label: 'Email', value: 'email' }],
    status: 'open',
  },
};

describe('answerElicitationOptimistically', () => {
  it('resolves the question before submitting the answer', async () => {
    const events: string[] = [];
    let messages = [openMessage];
    const updateMessages = (update: (current: Message[]) => Message[]): void => {
      events.push('resolved');
      messages = update(messages);
    };
    const submit = vi.fn(async () => {
      events.push('submitted');
      return 'done';
    });

    await expect(answerElicitationOptimistically({
      answer: 'email',
      elicitationId: 'question-one',
      previousMessage: openMessage,
      submit,
      updateMessages,
    })).resolves.toBe('done');

    expect(events).toEqual(['resolved', 'submitted']);
    expect(messages[0]?.elicitation).toMatchObject({ status: 'answered', answer: 'email' });
  });

  it('restores the open question when submission fails', async () => {
    let messages = [openMessage];
    const updateMessages = (update: (current: Message[]) => Message[]): void => {
      messages = update(messages);
    };

    await expect(answerElicitationOptimistically({
      answer: 'email',
      elicitationId: 'question-one',
      previousMessage: openMessage,
      submit: () => Promise.reject(new Error('Could not save answer')),
      updateMessages,
    })).rejects.toThrow('Could not save answer');

    expect(messages).toEqual([openMessage]);
  });
});

describe('elicitation normalization', () => {
  it('uses one transcript identity for open and answered representations', () => {
    expect(elicitationMessageId('question-one')).toBe('elicitation-question-one');
  });

  it('normalizes durable answered questions and nullable option descriptions', () => {
    expect(normalizeElicitation({
      id: 'question-durable',
      prompt: 'Where should it go?',
      responseType: 'radio',
      options: [{ label: 'Email', value: 'email', description: null }],
      minimumSelections: 1,
      maximumSelections: 1,
      targetUserId: null,
      status: 'answered',
      answer: 'email',
      createdAt: '2026-08-05T12:00:00.000Z',
    })).toMatchObject({
      id: 'question-durable',
      responseType: 'radio',
      options: [{ label: 'Email', value: 'email' }],
      status: 'answered',
      answer: 'email',
    });
  });
});
