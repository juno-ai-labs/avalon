import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_PREFERENCES_STORAGE_KEY } from '../lib/device-preferences';
import { AgentCompactionIndicator, AgentWorkTiming } from './agent-work-timing';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ paused = false, size, speed, state, theme }: { paused?: boolean; size: number; speed?: number; state: string; theme?: string }) => (
    <span
      data-paused={String(paused)}
      data-size={size}
      data-speed={speed}
      data-state={state}
      data-testid="thinking-orb"
      data-theme={theme}
    />
  ),
}));

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

/** The appearance the window is drawn in, as the device preference stores it. */
function pinAppearance(mode: 'light' | 'dark'): void {
  window.localStorage.setItem(
    DEVICE_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ version: 1, theme: { family: 'terra', mode } }),
  );
}

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

  it('advances by every segment running at once, so the total never jumps at settle', () => {
    // A batch's tool calls run concurrently in Bind, so a grouped plugin row can
    // be timing two plugins at the same time and its completed total counts
    // both. Advancing by one start would under-count the live number and let it
    // jump to the real total the moment they settled.
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(10_000);
    try {
      const { rerender } = render(
        <AgentWorkTiming active durationMs={6_000} monotonicStartedAt={[8_000, 8_000]} />,
      );

      // 6s completed, plus 2s elapsed on each of the two running segments.
      expect(screen.getByText('working for 10s')).toBeInTheDocument();

      // Settling records what both segments actually ran, and the live number
      // was already there rather than stepping up to meet it.
      rerender(<AgentWorkTiming active={false} durationMs={10_000} />);
      expect(screen.getByText('worked for 10s')).toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('takes a lone start as a number, the shape every other caller passes', () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(10_000);
    try {
      render(<AgentWorkTiming active durationMs={3_000} monotonicStartedAt={8_000} />);
      expect(screen.getByText('working for 5s')).toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([
    { activeName: undefined, activeVerb: undefined, expected: 'Rally is working' },
    { activeName: 'Rally is thinking', activeVerb: 'thinking', expected: 'Rally is thinking' },
    { activeName: 'Slack is working', activeVerb: 'Slack is working', expected: 'Slack is working' },
  ])('speaks $expected while it runs', ({ activeName, activeVerb, expected }) => {
    // The visible label ticks ten times a second, so the live region carries a
    // stable sentence instead. Every caller that overrides the verb owns that
    // sentence: deriving it from the verb left a thinking row announcing the
    // bare word "thinking", a gerund with no subject.
    render(
      <AgentWorkTiming
        active
        durationMs={83_000}
        {...(activeName === undefined ? {} : { activeName })}
        {...(activeVerb === undefined ? {} : { activeVerb })}
      />,
    );

    expect(screen.getByRole('status')).toHaveAccessibleName(expected);
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

  it('says only what it knows when the completed total is unknown', () => {
    render(<AgentWorkTiming active={false} durationMs={null} />);

    expect(screen.getByText('worked')).toBeInTheDocument();
    expect(screen.queryByText(/for/u)).not.toBeInTheDocument();
  });

  it('stays silent about the number while running with an unknown total', () => {
    // The live segment is real, but it is not the whole: printing it alone
    // reads as the total, which is the same overstatement as `0ms`.
    render(
      <AgentWorkTiming active durationMs={null} monotonicStartedAt={[performance.now() - 3_000]} />,
    );

    expect(screen.getByText('working')).toBeInTheDocument();
    expect(screen.queryByText(/3s/u)).not.toBeInTheDocument();
  });
});

/**
 * The orb is a canvas the stylesheet cannot reach, so the only way its ink
 * follows the theme is the prop. Pinned to `dark`, it drew near-white dots on
 * a light window — legible in a component assertion and all but invisible on
 * screen.
 */
describe('the orb ink', () => {
  it.each([['light'], ['dark']] as const)('draws for a %s window', (mode) => {
    pinAppearance(mode);

    render(<AgentWorkTiming active durationMs={0} startedAt={Date.now()} />);

    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-theme', mode);
  });

  it('draws compaction for the window it is in', () => {
    pinAppearance('light');

    render(<AgentCompactionIndicator />);

    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-theme', 'light');
  });
});
