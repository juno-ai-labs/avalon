import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCompactionIndicator, AgentWorkTiming } from './agent-work-timing';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ paused = false, size, speed, state }: { paused?: boolean; size: number; speed?: number; state: string }) => (
    <span
      data-paused={String(paused)}
      data-size={size}
      data-speed={speed}
      data-state={state}
      data-testid="thinking-orb"
    />
  ),
}));

afterEach(() => vi.useRealTimers());

describe('AgentWorkTiming', () => {
  it('announces compaction as a distinct active agent phase', () => {
    const { container } = render(<AgentCompactionIndicator />);

    expect(screen.getByText('Compacting conversation context…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAccessibleName(
      'Rally is compacting the conversation context',
    );
    expect(container.querySelector('.agent-work-timing')).toHaveClass('agent-work-timing-active');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-speed', '1');
  });

  it('owns the live wording, shimmer, elapsed time, orb, and settled state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    const startedAt = Date.now();
    const { container, rerender } = render(
      <AgentWorkTiming active durationMs={82_000} startedAt={startedAt} />,
    );

    expect(screen.getByText('working for 1m 22s')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Rally is working' })).toBeInTheDocument();
    expect(container.querySelector('.agent-work-timing')).toHaveClass('agent-work-timing-active');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-state', 'solving');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-size', '20');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-paused', 'false');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-speed', '1');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText('working for 1m 23s')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAccessibleName('Rally is working');

    rerender(<AgentWorkTiming active={false} durationMs={83_000} />);
    expect(screen.getByText('worked for 1m 23s')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAccessibleName('worked for 1m 23s');
    expect(container.querySelector('.agent-work-timing')).not.toHaveClass('agent-work-timing-active');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-paused', 'true');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-speed', '0');
  });

  it.each([
    { active: true, label: 'working for 1m 23s', state: 'a paused active segment' },
    { active: false, label: 'worked for 1m 23s', state: 'an initially completed segment' },
  ])('renders $state at the paused first frame', ({ active, label }) => {
    render(<AgentWorkTiming active={active} durationMs={83_000} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-paused', 'true');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-speed', '0');
  });

  it('qualifies a recovered terminal duration as an upper bound', () => {
    render(
      <AgentWorkTiming
        active={false}
        durationMs={83_000}
        timingAccuracy="upper_bound"
      />,
    );

    expect(screen.getByText('worked for at most 1m 23s')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAccessibleName('worked for at most 1m 23s');
  });
});
