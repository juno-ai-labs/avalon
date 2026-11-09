import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { feedRowGap, measureMessageFeedRow, MessageFeed } from './message-feed';
import type { Message } from '../lib/types';

const answer_ = vi.fn(async () => undefined);
const answer = answer_;

function message(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    workstreamId: 'workstream-1',
    authorType: 'agent',
    author: undefined,
    text: 'A settled answer.',
    messageType: 'text',
    createdAt: '2026-09-01T09:00:00.000Z',
    attachments: [],
    mentions: [],
    ...overrides,
  } as Message;
}

/**
 * The feed both conversation surfaces render. Every assertion here is a thing
 * the automation draft screen did not do while it looped over `MessageBlock`
 * itself, which is what these cover: that one component now decides them for
 * both surfaces rather than each screen deciding separately.
 */
describe('MessageFeed', () => {
  it('measures the row that is live now instead of replaying an older resize entry', () => {
    const row = document.createElement('div');
    const rect = vi.spyOn(row, 'getBoundingClientRect');
    rect.mockReturnValueOnce({ height: 413.6 } as DOMRect);
    rect.mockReturnValueOnce({ height: 276.2 } as DOMRect);

    expect(measureMessageFeedRow(row)).toBe(414);
    expect(measureMessageFeedRow(row)).toBe(276);
    expect(rect).toHaveBeenCalledTimes(2);
  });

  /**
   * The gap a row owns above itself comes from the message list, not from a
   * DOM sibling: in the windowed feed the first mounted row has no sibling
   * whatever its index, so a sibling-based rule gave it no gap at the window's
   * edge. Index 0 is the only row with none; a row after an unloaded stretch
   * has no known predecessor and takes the seam gap whatever its kind, since
   * nothing else marks the seam and the turn gap is now the closest distance.
   */
  it('stamps each row with the gap its predecessor decides', () => {
    const human = message({ id: 'turn-1', authorType: 'human', author: { id: 'user-1', name: 'Adam' }, text: 'Look into it.' });
    const note = message({ id: 'note', authorType: 'system', messageType: 'system', text: 'Reviewing.' });
    const tool = message({ id: 'tool', messageType: 'tool_event', text: undefined, toolEvent: { id: 't', name: 'Search', status: 'completed' } });
    const answer = message({ id: 'answer', text: 'Found it.' });
    const reply = message({ id: 'turn-2', authorType: 'human', author: { id: 'user-1', name: 'Adam' }, text: 'Thanks.' });
    const afterGap = message({ id: 'turn-3', text: 'Later.', precededByTranscriptGap: true });
    const eventAfterGap = message({ id: 'tool-2', messageType: 'tool_event', text: undefined, toolEvent: { id: 't2', name: 'Search', status: 'completed' }, precededByTranscriptGap: true });
    render(<MessageFeed messages={[human, note, tool, answer, reply, afterGap, eventAfterGap]} onAnswerElicitation={answer_} />);

    const gaps = [...document.querySelectorAll('.virtual-message-row')].map((row) => row.getAttribute('data-row-gap'));
    expect(gaps).toEqual(['none', 'block', 'event', 'event', 'stack', 'seam', 'seam']);
    // Rally's answer sits on its work; a person's reply after an event does not.
    expect(feedRowGap(tool, answer)).toBe('event');
    expect(feedRowGap(tool, reply)).toBe('block');
    // The seam wins over the kinds on either side of it: a turn after a turn
    // and an event after a turn both take it when the stretch between them is
    // unloaded, so neither reads as the tightest pair on screen.
    expect(feedRowGap(reply, afterGap)).toBe('seam');
    expect(feedRowGap(afterGap, eventAfterGap)).toBe('seam');
  });

  it('renders every message when the adapter does not window the list', () => {
    render(
      <MessageFeed
        messages={[
          message({ id: 'message-1', text: 'First.' }),
          message({ id: 'message-2', text: 'Second.' }),
          message({ id: 'message-3', text: 'Third.' }),
        ]}
        onAnswerElicitation={answer}
      />,
    );

    expect(screen.getByText('First.')).toBeVisible();
    expect(screen.getByText('Second.')).toBeVisible();
    expect(screen.getByText('Third.')).toBeVisible();
    expect(document.querySelectorAll('.virtual-message-row')).toHaveLength(3);
  });

  it('folds an assistant answer into collapsible sections', () => {
    render(
      <MessageFeed
        messages={[message({
          id: 'message-headings',
          text: '## Summary\n\nReady.\n\n## Details\n\nEvery day.',
        })]}
        onAnswerElicitation={answer}
      />,
    );

    const article = screen.getByRole('heading', { name: 'Summary' }).closest('article');
    expect(article).not.toBeNull();
    expect(article!.querySelectorAll('.markdown-collapse')).toHaveLength(2);
    const sections = within(article!).getAllByRole('button', { name: 'Collapse section' });
    expect(sections).toHaveLength(2);
    for (const section of sections) expect(section).toBeVisible();
  });

  it('draws the placeholder rather than a blank row for a message too large to send', () => {
    render(
      <MessageFeed
        messages={[message({ id: 'message-huge', blocksOmittedPlaceholder: true })]}
        onAnswerElicitation={answer}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('This message is too large to display.');
    expect(screen.queryByText('A settled answer.')).not.toBeInTheDocument();
  });

  it('marks where unread begins, and only there', () => {
    render(
      <MessageFeed
        firstUnreadIndex={1}
        messages={[
          message({ id: 'message-read', text: 'Read.' }),
          message({ id: 'message-unread', text: 'Unread.' }),
        ]}
        onAnswerElicitation={answer}
      />,
    );

    // The day the turns were said on is a separator as well, over the first.
    const dividers = screen.getAllByRole('separator').filter((divider) => divider.classList.contains('unread-divider'));
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toHaveTextContent('Unread messages');
    expect(dividers[0]!.closest('.virtual-message-row')).toHaveAttribute('data-index', '1');
  });

  it('names the day over the first turn of each day, and only there', () => {
    render(
      <MessageFeed
        messages={[
          message({ id: 'message-a', text: 'One.', createdAt: '2026-07-30T15:00:00.000Z' }),
          message({ id: 'message-b', text: 'Two.', createdAt: '2026-07-30T15:05:00.000Z' }),
          message({ id: 'message-c', text: 'Three.', createdAt: '2026-07-31T15:00:00.000Z' }),
        ]}
        onAnswerElicitation={answer}
      />,
    );

    const days = screen.getAllByRole('separator').filter((divider) => divider.classList.contains('day-divider'));
    expect(days.map((divider) => divider.closest('.virtual-message-row')?.getAttribute('data-index'))).toEqual(['0', '2']);
    expect(days.map((divider) => divider.textContent)).toEqual(['Jul 30', 'Jul 31']);
  });

  it('holds system-row disclosure itself, so neither surface tracks it', () => {
    render(
      <MessageFeed
        messages={[message({
          id: 'message-system',
          authorType: 'system',
          messageType: 'system',
          text: 'Rally noted something.',
        })]}
        onAnswerElicitation={answer}
      />,
    );

    expect(screen.getByText(/Rally noted something\./)).toBeInTheDocument();
  });

});
