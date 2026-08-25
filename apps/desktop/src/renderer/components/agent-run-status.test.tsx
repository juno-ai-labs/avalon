import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationPluginActivity } from '@rally/contracts';
import { AgentRunStatus, foldRunActivities, type AgentRunActivity } from './agent-run-status';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ state }: { state: string }) => <span data-state={state} data-testid="thinking-orb" />,
}));

const slack: AutomationPluginActivity = { pluginId: 'plugin_slack', displayName: 'Slack', icon: 'brand-slack' };
const google: AutomationPluginActivity = { pluginId: 'plugin_google', displayName: 'Google Mail + Calendar', icon: 'brand-google' };

function activity(overrides: Partial<AgentRunActivity> & { id: string }): AgentRunActivity {
  return { name: 'Searched Slack', status: 'completed', ...overrides };
}

const labels = {
  idleLabel: 'Understanding your automation request',
  finalizingLabel: 'Finalizing your automation',
};

describe('AgentRunStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the understanding label with a ticking counter before any tool runs', () => {
    render(<AgentRunStatus events={[]} startedAt={Date.now()} {...labels} />);

    expect(screen.getByText('Understanding your automation request')).toBeInTheDocument();
    expect(screen.getByText('· Running for 1s')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Rally is working' })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText('· Running for 5s')).toBeInTheDocument();
  });

  it('names the running tool with its provider face, then finalizes once every call settles', () => {
    const startedAt = Date.now();
    const running = [
      activity({ id: 'tool-1', name: 'Checking the connected account on Google Mail + Calendar', status: 'started', plugin: google }),
    ];
    const { rerender } = render(<AgentRunStatus events={running} startedAt={startedAt} {...labels} />);

    expect(screen.getByText('Checking the connected account on Google Mail + Calendar')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Plugin: Google Mail + Calendar' })).toBeInTheDocument();
    expect(screen.queryByTestId('thinking-orb')).not.toBeInTheDocument();

    rerender(
      <AgentRunStatus
        events={[activity({ id: 'tool-1', name: 'Checked the connected account on Google Mail + Calendar', plugin: google })]}
        startedAt={startedAt}
        {...labels}
      />,
    );
    expect(screen.getByText('Finalizing your automation')).toBeInTheDocument();
    expect(screen.getByTestId('thinking-orb')).toBeInTheDocument();
  });

  it('settles into a duration with one face per provider and a collapsed timeline', () => {
    const startedAt = Date.now();
    const events = [
      activity({ id: 'tool-1', name: 'Checked the connected account on Google Mail + Calendar', summary: 'Read the Gmail profile', plugin: google, durationMs: 900 }),
      activity({ id: 'tool-2', summary: 'Found 1 matching Slack user', plugin: slack, durationMs: 300 }),
      activity({ id: 'tool-3', summary: 'Found 0 matching Slack conversations', plugin: slack, durationMs: 320 }),
    ];
    render(
      <AgentRunStatus
        completedAt={startedAt + 83_000}
        events={events}
        outcome="completed"
        startedAt={startedAt}
        {...labels}
      />,
    );

    expect(screen.getByText('Ran for 1m 23s')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Rally ran for 1m 23s' })).toBeInTheDocument();
    expect(screen.queryByText(/Running for/)).not.toBeInTheDocument();
    // One face per provider, however many calls each one served.
    expect(screen.getAllByRole('img', { name: 'Plugin: Slack' })).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: 'Plugin: Google Mail + Calendar' })).toHaveLength(1);

    // The record is closed until asked for, and duplicate calls fold into one
    // counted row rather than repeating.
    expect(screen.queryByText('Searched Slack')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show what Rally did' }));
    expect(screen.getByText('Searched Slack')).toBeInTheDocument();
    expect(screen.getByText('×2')).toBeInTheDocument();
    expect(screen.getByText('Found 0 matching Slack conversations')).toBeInTheDocument();
    expect(screen.queryByText('Found 1 matching Slack user')).not.toBeInTheDocument();
    expect(screen.getByText('Read the Gmail profile')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide what Rally did' }));
    expect(screen.queryByText('Searched Slack')).not.toBeInTheDocument();
  });

  it('reports a failed run as stopped rather than as having run to completion', () => {
    const startedAt = Date.now();
    render(
      <AgentRunStatus
        completedAt={startedAt + 4_000}
        events={[activity({ id: 'tool-1', status: 'failed', name: 'Could not reach Slack', plugin: slack })]}
        outcome="failed"
        startedAt={startedAt}
        {...labels}
      />,
    );

    expect(screen.getByText('Stopped after 4s')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Rally stopped after 4s' })).toBeInTheDocument();
  });

  it('keeps a failed call in its own row instead of folding it into the successes', () => {
    const folded = foldRunActivities([
      activity({ id: 'tool-1', plugin: slack }),
      activity({ id: 'tool-2', status: 'failed', name: 'Searched Slack', plugin: slack }),
      activity({ id: 'tool-3', plugin: slack }),
    ]);
    expect(folded).toHaveLength(2);
    expect(folded.map((entry) => [entry.count, entry.failed])).toEqual([[2, false], [1, true]]);
  });
});
