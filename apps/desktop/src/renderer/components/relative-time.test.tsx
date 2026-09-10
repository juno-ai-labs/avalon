import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RelativeTime } from './relative-time';

afterEach(() => vi.useRealTimers());

describe('RelativeTime', () => {
  it('keeps its label current without its host re-rendering', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:30.000Z'));
    render(<RelativeTime value="2026-09-10T12:00:00.000Z" />);

    expect(screen.getByText('just now')).toHaveAttribute('dateTime', '2026-09-10T12:00:00.000Z');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });

    expect(screen.getByText('1 minute ago')).toHaveAttribute('dateTime', '2026-09-10T12:00:00.000Z');
  });

  it('reads through a caller-supplied vocabulary against the same clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
    const format = (value: string, now: Date): string => `${value} at ${now.toISOString()}`;
    render(<RelativeTime format={format} value="2026-09-10T11:00:00.000Z" />);

    expect(screen.getByText('2026-09-10T11:00:00.000Z at 2026-09-10T12:00:00.000Z')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByText('2026-09-10T11:00:00.000Z at 2026-09-10T12:00:10.000Z')).toBeInTheDocument();
  });

  it('says so plainly when the instant cannot be read, in the label and the tooltip', async () => {
    // A malformed timestamp reaches the renderer as a string like any other, and
    // the row it sits in should still draw. Both halves have to answer, or the
    // label reads "Unknown time" and the tooltip under it reads "Invalid Date".
    render(<RelativeTime value="not-a-timestamp" />);

    const label = screen.getByText('Unknown time');
    expect(label).toHaveAttribute('dateTime', 'not-a-timestamp');

    fireEvent.pointerMove(label, { pointerType: 'mouse' });

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Unknown time');
  });

  it('names the exact local time on hover', async () => {
    // Built from local components so the assertion holds in any zone; the
    // year and the minute are the literal, not a second run of the formatter.
    const instant = new Date(2026, 8, 10, 15, 42).toISOString();
    render(<RelativeTime value={instant} />);

    fireEvent.pointerMove(screen.getByRole('time'), { pointerType: 'mouse' });

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(/2026/u);
    expect(tooltip).toHaveTextContent(/3:42/u);
  });
});
