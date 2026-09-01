import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Message, WorkspaceMember } from '../lib/types';
import {
  ComposerQueue,
  moveWithin,
  queueAuthorMember,
  queuePreviewLabel,
  type ComposerQueueItem,
} from './composer-queue';

const ada: WorkspaceMember = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  timezone: 'America/Los_Angeles',
};
const bob: WorkspaceMember = {
  id: 'user-2',
  name: 'Bob Builder',
  email: 'bob@example.com',
  timezone: 'America/Los_Angeles',
};

function dataTransfer(dropEffect: 'move' | 'none' = 'move'): {
  dropEffect: string;
  effectAllowed: string;
  setData: ReturnType<typeof vi.fn>;
} {
  return { dropEffect, effectAllowed: 'none', setData: vi.fn() };
}

describe('composer queue helpers', () => {
  it('lifts an id to the requested index', () => {
    expect(moveWithin(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveWithin(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
  });

  it('prefers the roster member and falls back to the author snapshot', () => {
    const message = {
      id: 'turn-1',
      workstreamId: 'ws',
      sequenceNumber: 1,
      authorType: 'human' as const,
      messageType: 'text' as const,
      createdAt: '2026-08-05T12:00:00.000Z',
      author: { id: ada.id, name: 'Stale name', avatarUrl: 'https://example.test/stale.png' },
      text: 'Hello',
    } satisfies Message;
    expect(queueAuthorMember(message, [ada, bob])).toEqual(ada);
    expect(queueAuthorMember(message, [bob])).toMatchObject({
      id: ada.id,
      name: 'Stale name',
      avatarUrl: 'https://example.test/stale.png',
    });
  });

  it('unwrites link and image syntax for the accessible name, keeping the label', () => {
    expect(queuePreviewLabel('Ask [@Ada Lovelace](person:00000000-0000-7000-8000-000000000042) first'))
      .toBe('Ask @Ada Lovelace first');
    expect(queuePreviewLabel('See ![the chart](resource:abc) here')).toBe('See the chart here');
    expect(queuePreviewLabel('Read [the notes](https://example.test/x "Title")')).toBe('Read the notes');
    expect(queuePreviewLabel('  spaced  ')).toBe('spaced');
  });
});

describe('ComposerQueue', () => {
  const items: ComposerQueueItem[] = [
    { key: 'a', inputId: 'input-a', text: 'Open a PR after', mentions: [], member: ada, sending: false },
    { key: 'b', inputId: 'input-b', text: 'and check for comments', mentions: [], member: bob, sending: false },
  ];

  it('shows each queued message with its author avatar', () => {
    render(<ComposerQueue items={items} onReorder={vi.fn(async () => undefined)} />);
    expect(screen.getByRole('list', { name: 'Queued messages' })).toBeInTheDocument();
    expect(screen.getByText('Open a PR after')).toBeInTheDocument();
    expect(screen.getByText('and check for comments')).toBeInTheDocument();
    expect(document.querySelectorAll('.composer-queue-avatar .avatar')).toHaveLength(2);
    expect(screen.getByTitle('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByTitle('Bob Builder')).toBeInTheDocument();
  });

  it('renders the queued message as Markdown rather than as its source', () => {
    render(
      <ComposerQueue
        items={[{
          key: 'c',
          inputId: 'input-c',
          text: 'Ship **today** and add `--force`\n\n# Not a heading here',
          mentions: [],
          member: ada,
          sending: false,
        }]}
        onReorder={vi.fn(async () => undefined)}
      />,
    );
    const row = screen.getByRole('list', { name: 'Queued messages' });
    // The transcript's renderer, so the row carries its markup and its class.
    expect(row.querySelector('.composer-queue-text .markdown-body')).toBeInTheDocument();
    expect(row.querySelector('.composer-queue-text strong')).toHaveTextContent('today');
    expect(row.querySelector('.composer-queue-text code')).toHaveTextContent('--force');
    expect(row.textContent).toContain('Not a heading here');
    expect(row.textContent).not.toContain('**today**');
    expect(row.textContent).not.toContain('# Not a heading');
  });

  it('draws a person mention as the chip the transcript draws', () => {
    const personId = '00000000-0000-7000-8000-000000000042';
    render(
      <ComposerQueue
        items={[{
          key: 'd',
          inputId: 'input-d',
          text: `Ask [@Spoofed label](person:${personId}) to review`,
          mentions: [{
            type: 'person',
            personId,
            displayName: 'Ada Lovelace',
            avatarUrl: 'https://example.test/ada.png',
            startOffset: 4,
            endOffset: 65,
          }],
          member: bob,
          sending: false,
        }]}
        onReorder={vi.fn(async () => undefined)}
      />,
    );
    const chip = screen.getByText('@Ada Lovelace').closest('.mention-chip');
    expect(chip).toHaveAttribute('data-person-id', personId);
    expect(screen.queryByText('@Spoofed label')).not.toBeInTheDocument();
    // A queued row is a preview of something not yet said: nothing in it opens.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reorder queued message: Ask @Spoofed label to review' }))
      .toBeInTheDocument();
  });

  it('draws a connection mention from its stored offsets', () => {
    const text = 'Check @Google Drive for it';
    render(
      <ComposerQueue
        items={[{
          key: 'e',
          inputId: 'input-e',
          text,
          mentions: [{
            type: 'connector',
            connectorType: 'google_drive',
            startOffset: text.indexOf('@Google Drive'),
            endOffset: text.indexOf('@Google Drive') + '@Google Drive'.length,
          }],
          member: ada,
          sending: false,
        }]}
        onReorder={vi.fn(async () => undefined)}
      />,
    );
    const chip = document.querySelector('.composer-queue-text .mention-chip-connector');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent('Google Drive');
    expect(document.querySelector('.composer-queue-text')?.textContent).not.toContain('](connector');
  });

  it('keeps a placeholder for a message with no text of its own', () => {
    render(
      <ComposerQueue
        items={[
          { key: 'f', inputId: 'input-f', text: '   ', mentions: [], member: ada, sending: false },
          { key: 'g', inputId: null, text: '', mentions: [], member: bob, sending: true },
        ]}
        onReorder={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByText('Queued message')).toBeInTheDocument();
    expect(screen.getByText('Sending…')).toBeInTheDocument();
  });

  it('commits the live drag order once on drop', async () => {
    const onReorder = vi.fn(async () => undefined);
    render(<ComposerQueue items={items} onReorder={onReorder} />);
    const grips = screen.getAllByRole('button', { name: /Reorder queued message/u });
    const firstRow = screen.getByText('Open a PR after').closest('li')!;
    fireEvent.dragStart(grips[1]!, { dataTransfer: dataTransfer() });
    fireEvent.dragOver(firstRow, { dataTransfer: dataTransfer() });
    fireEvent.dragEnd(grips[1]!, { dataTransfer: dataTransfer('move') });
    await waitFor(() => expect(onReorder).toHaveBeenCalledWith(['input-b', 'input-a']));
    expect(onReorder).toHaveBeenCalledTimes(1);
  });

  it('abandons a drag that ends with dropEffect none', async () => {
    const onReorder = vi.fn(async () => undefined);
    render(<ComposerQueue items={items} onReorder={onReorder} />);
    const grips = screen.getAllByRole('button', { name: /Reorder queued message/u });
    fireEvent.dragStart(grips[1]!, { dataTransfer: dataTransfer() });
    fireEvent.dragOver(screen.getByText('Open a PR after').closest('li')!, { dataTransfer: dataTransfer() });
    fireEvent.dragEnd(grips[1]!, { dataTransfer: dataTransfer('none') });
    await waitFor(() => expect(screen.getByText('Open a PR after')).toBeInTheDocument());
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('moves a row with the arrow keys on the grip', async () => {
    const onReorder = vi.fn(async () => undefined);
    render(<ComposerQueue items={items} onReorder={onReorder} />);
    const grips = screen.getAllByRole('button', { name: /Reorder queued message/u });
    fireEvent.keyDown(grips[1]!, { key: 'ArrowUp' });
    await waitFor(() => expect(onReorder).toHaveBeenCalledWith(['input-b', 'input-a']));
  });
});
