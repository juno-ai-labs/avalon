import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Message } from '../lib/types';
import { BreakoutOrigin, breakoutOriginMessages, originExcerpt } from './breakout-origin';

const said = (sequence: number, overrides: Partial<Message> = {}): Message => ({
  id: `row-${sequence}`,
  transcriptTurnId: `turn-${sequence}`,
  workstreamId: 'workstream-1',
  sequenceNumber: sequence,
  authorType: sequence % 2 === 0 ? 'agent' : 'human',
  author: { id: 'user-1', name: 'Adam' },
  messageType: 'text',
  text: `Message ${sequence}`,
  createdAt: '2026-09-09T20:00:00.000Z',
  ...overrides,
});

describe('where a breakout started', () => {
  it('is the origin message and the three said before it, oldest first', () => {
    const transcript = [1, 2, 3, 4, 5, 6].map((sequence) => said(sequence));

    const origin = breakoutOriginMessages(transcript, 'turn-6');

    expect(origin?.origin.text).toBe('Message 6');
    expect(origin?.context.map((message) => message.text)).toEqual(['Message 3', 'Message 4', 'Message 5']);
  });

  it('counts only what was said, not the tool rows a turn was made of', () => {
    const transcript = [
      said(1),
      said(2, { messageType: 'tool_event', text: 'search' }),
      said(3, { authorType: 'system', text: 'Adam joined' }),
      said(4),
    ];

    expect(breakoutOriginMessages(transcript, 'turn-4')?.context.map((message) => message.text))
      .toEqual(['Message 1']);
  });

  it('shows nothing for an origin off the loaded window or a breakout with none', () => {
    const transcript = [1, 2].map((sequence) => said(sequence));
    expect(breakoutOriginMessages(transcript, 'turn-99')).toBeNull();
    expect(breakoutOriginMessages(transcript, null)).toBeNull();
  });

  it('fades each earlier message a step further back and names the Channel on the card', () => {
    render(<BreakoutOrigin
      channelTitle="Morning calls"
      context={[said(1, { text: 'First **thing**' }), said(2, { text: 'Then this' })]}
      origin={said(3, { text: 'The origin' })}
    />);

    const region = screen.getByRole('region', { name: 'Where this breakout started' });
    const items = within(region).getAllByRole('listitem');
    // Markdown is read as plain text in an excerpt.
    expect(items.map((item) => item.textContent)).toEqual(['AdamFirst thing', 'RallyThen this']);
    expect(items.map((item) => item.style.getPropertyValue('--origin-step'))).toEqual(['2', '1']);
    expect(within(region).getByText(/Adam · .* · in Morning calls/u)).toBeInTheDocument();
    expect(within(region).getByText('The origin')).toBeInTheDocument();
  });

  it('keeps a message that is only code, rather than drawing an empty card', () => {
    expect(originExcerpt('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });
});
