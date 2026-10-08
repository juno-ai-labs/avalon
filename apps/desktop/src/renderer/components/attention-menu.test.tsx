import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { asSubstreamId, asUserId, asWorkstreamId, type ConversationAccessRequestItem } from '@rally/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttentionItem } from '../lib/attention-items';
import { AttentionMenu, type AccessDecision } from './attention-menu';

function Location(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderMenu(items: AttentionItem[], complete = true): void {
  render(<MemoryRouter initialEntries={['/']}>
    <Tooltip.Provider><AttentionMenu complete={complete} items={items} /></Tooltip.Provider>
    <Location />
  </MemoryRouter>);
}

/** Radix opens a dropdown on pointer down, not on click. */
function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

const mention: AttentionItem = {
  key: 'a:11',
  workstreamId: 'a',
  substreamId: '11',
  title: 'Pricing',
  channelTitle: 'Launch plan',
  reason: 'mentioned',
  at: '2026-10-01T10:00:00.000Z',
};
const unread: AttentionItem = {
  key: 'b',
  workstreamId: 'b',
  substreamId: null,
  title: 'Weekly sync',
  channelTitle: null,
  reason: 'unread',
  at: '2026-10-01T09:00:00.000Z',
};

describe('AttentionMenu', () => {
  afterEach(cleanup);

  it('shows a bell that says nothing needs attention when the list is empty', () => {
    renderMenu([]);
    const trigger = screen.getByRole('button', { name: 'Nothing needs your attention' });
    expect(trigger.textContent).toBe('');

    openMenu(trigger);
    expect(screen.getByRole('menu').textContent).toBe('Nothing needs your attention');
  });

  it('shows the count and opens the place a chosen item is waiting', () => {
    renderMenu([mention, unread]);
    const trigger = screen.getByRole('button', { name: '2 conversations need your attention' });
    expect(trigger.textContent).toBe('2');

    openMenu(trigger);
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.querySelector('.attention-menu-detail')?.textContent)).toEqual([
      'You were mentioned in Launch plan',
      'Unread',
    ]);

    fireEvent.click(items[0]!);
    expect(screen.getByTestId('location').textContent).toBe('/workstreams/a?substream=11');
  });

  it('does not say nothing needs attention while Channels are still loading', () => {
    renderMenu([], false);
    const trigger = screen.getByRole('button', { name: 'Still loading channels' });

    openMenu(trigger);
    expect(screen.getByRole('menu').textContent).toBe('Still loading channels');
  });

  it('keeps the button to two digits past 99 and names the exact count', () => {
    const many = Array.from({ length: 150 }, (_, index): AttentionItem => ({ ...unread, key: `c${index}`, workstreamId: `c${index}` }));
    renderMenu(many);

    expect(screen.getByRole('button', { name: '150 conversations need your attention' }).textContent).toBe('99+');
  });
});

const request: ConversationAccessRequestItem = {
  id: '00000000-0000-4000-8000-0000000ac0r1',
  parentId: asWorkstreamId('00000000-0000-4000-8000-0000000ac0c0'),
  substreamId: asSubstreamId('0'),
  kind: 'channel',
  title: 'Hiring plan',
  appearance: null,
  markId: '00000000-0000-4000-8000-0000000ac0c0',
  requesterUserId: asUserId('00000000-0000-4000-8000-0000000ac013'),
  requesterName: 'Samantha Lee',
  requestedAt: '2026-10-07T12:00:00.000Z',
};

describe('AttentionMenu access requests', () => {
  afterEach(cleanup);

  function renderWithRequests(
    onDecide: (request: ConversationAccessRequestItem, decision: AccessDecision) => void,
    onOpenRequest: (request: ConversationAccessRequestItem) => void = () => undefined,
  ): void {
    render(<MemoryRouter initialEntries={['/']}>
      <Tooltip.Provider><AttentionMenu items={[unread]} onDecide={onDecide} onOpenRequest={onOpenRequest} requests={[request]} /></Tooltip.Provider>
      <Location />
    </MemoryRouter>);
  }

  it('counts a request with the conversations and lists it first with approve and decline', () => {
    const onDecide = vi.fn();
    renderWithRequests(onDecide);
    const trigger = screen.getByRole('button', { name: '1 conversation needs your attention, and 1 access request' });
    expect(trigger.textContent).toBe('2');
    openMenu(trigger);
    const row = screen.getByRole('group', { name: 'Samantha Lee asked to join Hiring plan' });
    expect(row.textContent).toContain('Samantha Lee asked to join');
    const rows = screen.getAllByText(/Hiring plan|Weekly sync/u).map((node) => node.textContent);
    expect(rows).toEqual(['Hiring plan', 'Weekly sync']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Approve Samantha Lee' }));
    expect(onDecide).toHaveBeenCalledWith(request, 'approve');
    // The menu stays open for the next request, and nothing navigated.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Decline Samantha Lee' }));
    expect(onDecide).toHaveBeenLastCalledWith(request, 'decline');
    expect(screen.getByTestId('location').textContent).toBe('/');
  });

  it('opens the request itself when the row, not a button, is chosen', () => {
    const onDecide = vi.fn();
    const onOpenRequest = vi.fn();
    renderWithRequests(onDecide, onOpenRequest);
    openMenu(screen.getByRole('button', { name: '1 conversation needs your attention, and 1 access request' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Hiring plan/u }));
    expect(onOpenRequest).toHaveBeenCalledWith(request);
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/');
  });
});
