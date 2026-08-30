import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Message, WorkspaceMember } from '../lib/types';
import {
  ComposerQueue,
  moveWithin,
  queueAuthorMember,
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
});

describe('ComposerQueue', () => {
  const items: ComposerQueueItem[] = [
    { key: 'a', inputId: 'input-a', text: 'Open a PR after', member: ada, sending: false },
    { key: 'b', inputId: 'input-b', text: 'and check for comments', member: bob, sending: false },
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
