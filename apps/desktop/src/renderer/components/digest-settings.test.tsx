import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DigestSettings,
  type DigestSettingsApi,
  digestSummaryText,
  inputValueToMinutes,
  minutesToLabel,
} from './digest-settings';
import type { DigestSchedule, WorkstreamConnection } from '../lib/types';

const savedSchedule: DigestSchedule = {
  id: '00000000-0000-4000-8000-000000000001',
  enabled: true,
  days: [1, 2, 3, 4, 5],
  times: [9 * 60],
  timezone: 'Europe/London',
  deliveryTargets: [
    { type: 'email', connectionId: null, displayName: 'ada@example.com', status: 'active', lastDeliveredAt: null },
  ],
  nextRunAt: null,
  lastDeliveredAt: null,
};

function apiWith(overrides: Partial<DigestSettingsApi> = {}): {
  api: DigestSettingsApi;
  updateDigestSchedule: ReturnType<typeof vi.fn>;
} {
  const updateDigestSchedule = vi.fn(async (input: Parameters<DigestSettingsApi['updateDigestSchedule']>[0]) => ({
    ...savedSchedule,
    ...input,
    deliveryTargets: input.deliveryTargets.map((target) => ({
      ...target,
      displayName: target.type === 'email' ? 'ada@example.com' : 'Slack',
      status: 'active' as const,
      lastDeliveredAt: null,
    })),
  }));
  return {
    updateDigestSchedule,
    api: {
      getDigestSchedule: async () => savedSchedule,
      updateDigestSchedule,
      ...overrides,
    } satisfies DigestSettingsApi,
  };
}

const onEditTimezone = vi.fn();

function renderSettings(
  api: DigestSettingsApi,
  connections: WorkstreamConnection[] = [],
): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DigestSettings api={api} connections={connections} onEditTimezone={onEditTimezone} />
    </QueryClientProvider>,
  );
}

describe('digest time formatting', () => {
  it('reads a time back the way someone would say it', () => {
    expect(minutesToLabel(9 * 60)).toBe('9:00 AM');
    expect(minutesToLabel(12 * 60)).toBe('Noon');
    expect(minutesToLabel(0)).toBe('Midnight');
    expect(minutesToLabel(16 * 60 + 30)).toBe('4:30 PM');
  });

  it('rejects a time that is not a time', () => {
    expect(inputValueToMinutes('09:00')).toBe(540);
    expect(inputValueToMinutes('24:00')).toBeNull();
    expect(inputValueToMinutes('09:75')).toBeNull();
    expect(inputValueToMinutes('nine')).toBeNull();
  });
});

describe('digest summary', () => {
  it('names a preset rather than listing its days', () => {
    expect(digestSummaryText({ enabled: true, days: [1, 2, 3, 4, 5], times: [9 * 60] }))
      .toBe('Once on weekdays, at 9:00 AM.');
    expect(digestSummaryText({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], times: [9 * 60, 16 * 60] }))
      .toBe('2 times on every day, at 9:00 AM, 4:00 PM.');
  });

  it('says what is missing rather than implying a digest will arrive', () => {
    expect(digestSummaryText({ enabled: true, days: [], times: [9 * 60] }))
      .toBe('Pick at least one day and one time.');
    expect(digestSummaryText({ enabled: false, days: [1], times: [9 * 60] })).toBe('Digests are off.');
  });
});

describe('DigestSettings', () => {
  it('shows the saved schedule with its days pressed', async () => {
    renderSettings(apiWith().api);

    await screen.findByRole('button', { name: 'Monday' });
    expect(screen.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Sunday' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Weekdays' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('9:00 AM')).toBeInTheDocument();
  });

  it('keeps Save inert until something actually changed', async () => {
    renderSettings(apiWith().api);

    const save = await screen.findByRole('button', { name: 'Save digest' });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Sunday' }));
    expect(save).toBeEnabled();
  });

  it('sends the edited days and times exactly once', async () => {
    const { api, updateDigestSchedule } = apiWith();
    renderSettings(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Weekends' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));

    await waitFor(() => expect(updateDigestSchedule).toHaveBeenCalledTimes(1));
    expect(updateDigestSchedule).toHaveBeenCalledWith({
      enabled: true,
      days: [0, 6],
      times: [540],
      deliveryTargets: [{ type: 'email', connectionId: null }],
    });
  });

  it('adds a time and keeps the list in order', async () => {
    const { api, updateDigestSchedule } = apiWith();
    renderSettings(api);

    const input = await screen.findByLabelText('New digest time');
    fireEvent.change(input, { target: { value: '07:30' } });
    fireEvent.click(screen.getByRole('button', { name: /Add time/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));

    await waitFor(() => expect(updateDigestSchedule).toHaveBeenCalled());
    expect(updateDigestSchedule.mock.calls[0]?.[0].times).toEqual([450, 540]);
  });

  it('refuses to add the same time twice', async () => {
    renderSettings(apiWith().api);

    const input = await screen.findByLabelText('New digest time');
    fireEvent.change(input, { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /Add time/u }));

    expect(await screen.findByText('That time is already on the list.')).toBeInTheDocument();
    expect(screen.getAllByText('9:00 AM')).toHaveLength(1);
  });

  it('removes a time', async () => {
    renderSettings(apiWith().api);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove 9:00 AM' }));

    expect(screen.queryByText('9:00 AM')).not.toBeInTheDocument();
    // An enabled digest with no times cannot be saved: it would sit in the
    // scheduler forever without ever producing anything.
    expect(screen.getByRole('button', { name: 'Save digest' })).toBeDisabled();
    expect(screen.getByText(/needs at least one day, one time, and one destination/u)).toBeInTheDocument();
  });

  it('offers a connector destination only when that connector says it can reach you', async () => {
    const reachable: WorkstreamConnection = {
      id: '00000000-0000-4000-8000-0000000000c1',
      modelPluginId: 'plugin_slack',
      connectorType: 'slack',
      displayName: 'Rally Studio',
      scope: 'workspace',
      status: 'healthy',
      userDelivery: { targetType: 'slack_agent_dm', label: 'Slack DM', description: 'Rally Agent DM.' },
    } as WorkstreamConnection;
    const unreachable = { ...reachable, id: '00000000-0000-4000-8000-0000000000c2', userDelivery: undefined };
    const { api, updateDigestSchedule } = apiWith();
    renderSettings(api, [reachable, unreachable]);

    const slack = await screen.findByText('Slack DM · Rally Studio');
    expect(screen.getAllByText(/Slack DM/u)).toHaveLength(1);

    fireEvent.click(slack.closest('label')!.querySelector('input')!);
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));

    await waitFor(() => expect(updateDigestSchedule).toHaveBeenCalled());
    expect(updateDigestSchedule.mock.calls[0]?.[0].deliveryTargets).toEqual([
      { type: 'email', connectionId: null },
      { type: 'slack_agent_dm', connectionId: '00000000-0000-4000-8000-0000000000c1' },
    ]);
  });

  it('replaces rather than stacks a second destination of the same kind', async () => {
    const slackA: WorkstreamConnection = {
      id: '00000000-0000-4000-8000-0000000000c1',
      modelPluginId: 'plugin_slack',
      connectorType: 'slack',
      displayName: 'Studio',
      scope: 'workspace',
      status: 'healthy',
      userDelivery: { targetType: 'slack_agent_dm', label: 'Slack DM', description: 'Rally Agent DM.' },
    } as WorkstreamConnection;
    const slackB = { ...slackA, id: '00000000-0000-4000-8000-0000000000c2', displayName: 'Side project' };
    const { api, updateDigestSchedule } = apiWith();
    renderSettings(api, [slackA, slackB]);

    // The table allows one destination per type, so selecting the second Slack
    // installation must swap the first rather than compose a save the API 422s.
    fireEvent.click((await screen.findByText('Slack DM · Studio')).closest('label')!.querySelector('input')!);
    fireEvent.click(screen.getByText('Slack DM · Side project').closest('label')!.querySelector('input')!);
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));

    await waitFor(() => expect(updateDigestSchedule).toHaveBeenCalled());
    expect(updateDigestSchedule.mock.calls[0]?.[0].deliveryTargets).toEqual([
      { type: 'email', connectionId: null },
      { type: 'slack_agent_dm', connectionId: '00000000-0000-4000-8000-0000000000c2' },
    ]);
  });

  it('surfaces a failed load instead of loading for ever', async () => {
    renderSettings(apiWith({
      getDigestSchedule: async () => { throw new Error('Digest is unavailable.'); },
    }).api);

    expect(await screen.findByText('Digest is unavailable.')).toBeInTheDocument();
  });

  it('points at connecting a tool when nothing can message you yet', async () => {
    renderSettings(apiWith().api);

    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
  });
});
