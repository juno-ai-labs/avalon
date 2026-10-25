import { describe, expect, it, vi } from 'vitest';
import type * as MessageExport from '../lib/message-export';
import type { Message } from '../lib/types';
import { ConversationExportRenderer, conversationExportTurns } from './conversation-export';

const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../lib/message-export', async (importOriginal) => {
  const actual = await importOriginal<typeof MessageExport>();
  return {
    ...actual,
    renderToHtml: (content: React.ReactElement) => { renders.count += 1; return actual.renderToHtml(content); },
  };
});

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

describe('rendering a conversation export', () => {
  it('draws each turn under its byline, and renders again only a turn that changed', () => {
    const renderer = new ConversationExportRenderer(undefined);
    const maya = message({ id: 'a', authorType: 'human', author: { id: 'u1', name: 'Maya' }, text: 'Where are we?' });
    const rally = message({ id: 'b', text: 'Two tiers are **settled**.' });
    renders.count = 0;

    const first = renderer.sections([maya, rally]);
    expect(renders.count).toBe(2);
    expect(first[0]).toContain('<span class="export-turn-author">Maya</span>');
    expect(first[1]).toContain('<strong>settled</strong>');

    expect(renderer.sections([maya, rally])).toEqual(first);
    expect(renders.count).toBe(2);

    const edited = renderer.sections([maya, { ...rally, text: 'Three tiers are settled.' }]);
    expect(renders.count).toBe(3);
    expect(edited[0]).toBe(first[0]);
    expect(edited[1]).toContain('Three tiers are settled.');
  });
});
