import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  BreakoutChipRow,
  BreakoutTickBar,
  breakoutHasActivity,
  breakoutNewsLabel,
  breakoutsByOrigin,
  orderBreakoutsForTicks,
  type BreakoutMark,
} from '@rally/ui/components/breakout-marks';

function mark(substreamId: string, overrides: Partial<BreakoutMark> = {}): BreakoutMark {
  return { substreamId, title: `Breakout ${substreamId}`, ...overrides };
}

describe('breakoutHasActivity', () => {
  it('is true for unread messages, a mention, an unseen breakout, or the directory flag', () => {
    expect(breakoutHasActivity(mark('quiet'))).toBe(false);
    expect(breakoutHasActivity(mark('zero', { unreadCount: 0 }))).toBe(false);
    expect(breakoutHasActivity(mark('unread', { unreadCount: 2 }))).toBe(true);
    expect(breakoutHasActivity(mark('mentioned', { youAreMentioned: true }))).toBe(true);
    expect(breakoutHasActivity(mark('unseen', { unseen: true }))).toBe(true);
    expect(breakoutHasActivity(mark('flagged', { needsAttention: true }))).toBe(true);
  });
});

describe('breakoutNewsLabel', () => {
  it('counts unread messages, says New when there is news but no count, and nothing when quiet', () => {
    expect(breakoutNewsLabel(mark('unread', { unreadCount: 3 }))).toBe('3 new');
    expect(breakoutNewsLabel(mark('mentioned', { youAreMentioned: true }))).toBe('New');
    expect(breakoutNewsLabel(mark('flagged', { needsAttention: true, unreadCount: 0 }))).toBe('New');
    expect(breakoutNewsLabel(mark('quiet', { unreadCount: 0 }))).toBeNull();
  });
});

describe('breakoutsByOrigin', () => {
  it('groups by origin turn in creation order and leaves out breakouts with no known origin', () => {
    const grouped = breakoutsByOrigin([
      mark('later', { originTurnId: 'turn-1', createdAt: '2026-09-02T00:00:00.000Z' }),
      mark('other', { originTurnId: 'turn-2', createdAt: '2026-09-01T12:00:00.000Z' }),
      mark('earlier', { originTurnId: 'turn-1', createdAt: '2026-09-01T00:00:00.000Z' }),
      mark('unplaced', { originTurnId: null, createdAt: '2026-08-01T00:00:00.000Z' }),
      mark('absent', { createdAt: '2026-08-01T00:00:00.000Z' }),
    ]);

    expect([...grouped.keys()]).toEqual(['turn-1', 'turn-2']);
    expect(grouped.get('turn-1')?.map((breakout) => breakout.substreamId)).toEqual(['earlier', 'later']);
    expect(grouped.get('turn-2')?.map((breakout) => breakout.substreamId)).toEqual(['other']);
  });

  it('breaks a creation-time tie by id', () => {
    const grouped = breakoutsByOrigin([
      mark('b', { originTurnId: 'turn-1', createdAt: '2026-09-01T00:00:00.000Z' }),
      mark('a', { originTurnId: 'turn-1', createdAt: '2026-09-01T00:00:00.000Z' }),
    ]);

    expect(grouped.get('turn-1')?.map((breakout) => breakout.substreamId)).toEqual(['a', 'b']);
  });
});

describe('orderBreakoutsForTicks', () => {
  it('orders by the loaded transcript position of the origin turn, then the unplaced by creation', () => {
    const ordered = orderBreakoutsForTicks([
      mark('unplaced-new', { createdAt: '2026-09-05T00:00:00.000Z' }),
      mark('on-third', { originTurnId: 'turn-3', createdAt: '2026-09-01T00:00:00.000Z' }),
      mark('off-page', { originTurnId: 'turn-old', createdAt: '2026-08-01T00:00:00.000Z' }),
      mark('on-first', { originTurnId: 'turn-1', createdAt: '2026-09-04T00:00:00.000Z' }),
      mark('on-first-earlier', { originTurnId: 'turn-1', createdAt: '2026-09-02T00:00:00.000Z' }),
    ], ['turn-1', 'turn-2', 'turn-3']);

    expect(ordered.map((breakout) => breakout.substreamId)).toEqual([
      'on-first-earlier',
      'on-first',
      'on-third',
      'off-page',
      'unplaced-new',
    ]);
  });
});

describe('BreakoutTickBar', () => {
  function renderBar(openSubstreamId: string | null, onOpen = vi.fn()) {
    render(<Tooltip.Provider>
      <BreakoutTickBar
        breakouts={[
          mark('quiet', { title: 'Pricing' }),
          mark('busy', { title: 'Hiring', unreadCount: 2 }),
          mark('open', { title: 'Launch' }),
        ]}
        onOpen={onOpen}
        openSubstreamId={openSubstreamId}
      />
    </Tooltip.Provider>);
    return { bar: screen.getByRole('navigation', { name: 'Breakouts in this channel' }), onOpen };
  }

  it('marks the open tick as current and names a tick with news', () => {
    const { bar } = renderBar('open');

    const ticks = within(bar).getAllByRole('button');
    expect(ticks.map((tick) => tick.getAttribute('aria-label'))).toEqual(['Pricing', 'Hiring, 2 new', 'Launch']);
    expect(ticks.map((tick) => tick.getAttribute('aria-current'))).toEqual([null, null, 'true']);
  });

  it('marks no tick current while no breakout is open, and opens the one pressed', () => {
    const { bar, onOpen } = renderBar(null);

    expect(within(bar).getAllByRole('button').filter((tick) => tick.hasAttribute('aria-current'))).toEqual([]);
    fireEvent.click(within(bar).getByRole('button', { name: 'Hiring, 2 new' }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ substreamId: 'busy' }));
  });

  it('draws nothing for a channel without breakouts', () => {
    render(<Tooltip.Provider><BreakoutTickBar breakouts={[]} onOpen={vi.fn()} openSubstreamId={null} /></Tooltip.Provider>);

    expect(screen.queryByRole('navigation', { name: 'Breakouts in this channel' })).not.toBeInTheDocument();
  });
});

describe('BreakoutChipRow', () => {
  it('presses the open chip, says what is new, and opens the one clicked', () => {
    const onOpen = vi.fn();
    render(<BreakoutChipRow
      breakouts={[mark('one', { title: 'Pricing', unreadCount: 1 }), mark('two', { title: 'Launch' })]}
      onOpen={onOpen}
      openSubstreamId="two"
    />);

    const row = screen.getByRole('group', { name: 'Breakouts from this message' });
    const [pricing, launch] = within(row).getAllByRole('button');
    expect(pricing).toHaveTextContent('Pricing· 1 new');
    expect(pricing).toHaveAttribute('aria-pressed', 'false');
    expect(launch).toHaveTextContent('Launch· Open');
    expect(launch).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pricing!);
    expect(onOpen).toHaveBeenCalledWith('one');
  });
});
