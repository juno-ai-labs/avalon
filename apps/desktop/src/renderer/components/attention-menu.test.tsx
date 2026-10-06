import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import type { AttentionItem } from '../lib/attention-items';
import { AttentionMenu } from './attention-menu';

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
