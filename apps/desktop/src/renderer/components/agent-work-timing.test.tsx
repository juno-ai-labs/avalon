import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkTiming } from './agent-work-timing';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ paused = false, size, state }: { paused?: boolean; size: number; state: string }) => (
    <span data-paused={String(paused)} data-size={size} data-state={state} data-testid="thinking-orb" />
  ),
}));

afterEach(() => vi.useRealTimers());

describe('AgentWorkTiming', () => {
  it('owns the live wording, shimmer, elapsed time, orb, and settled state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    const startedAt = Date.now();
    const { container, rerender } = render(
      <AgentWorkTiming active durationMs={82_000} startedAt={startedAt} />,
    );

    expect(screen.getByText('working for 1m 22s')).toBeInTheDocument();
    expect(container.querySelector('.agent-work-timing')).toHaveClass('agent-work-timing-active');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-state', 'solving');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-size', '20');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-paused', 'false');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText('working for 1m 23s')).toBeInTheDocument();

    rerender(<AgentWorkTiming active={false} durationMs={83_000} />);
    expect(screen.getByText('worked for 1m 23s')).toBeInTheDocument();
    expect(container.querySelector('.agent-work-timing')).not.toHaveClass('agent-work-timing-active');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-paused', 'true');
  });
});
