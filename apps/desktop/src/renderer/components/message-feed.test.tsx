import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { measureMessageFeedRow, MessageFeed } from './message-feed';
import type { Message } from '../lib/types';

const answer = vi.fn(async () => undefined);

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
    expect(within(article!).getByRole('button', { name: 'Collapse all sections' })).toBeVisible();
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

    const dividers = screen.getAllByRole('separator');
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toHaveTextContent('Unread messages');
    expect(dividers[0]!.closest('.virtual-message-row')).toHaveAttribute('data-index', '1');
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
