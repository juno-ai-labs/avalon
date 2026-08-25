import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApplicationSettings } from '../../common/desktop';
import type { WorkstreamDetail, WorkstreamResource } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { InspectorRail } from './inspector-rail';

const copyText = vi.hoisted(() => vi.fn());
const applicationSettings = vi.hoisted(() => ({
  current: { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true },
  listeners: new Set<(settings: unknown) => void>(),
}));

function announceApplicationSettings(settings: DesktopApplicationSettings): void {
  applicationSettings.current = settings;
  act(() => {
    for (const listener of applicationSettings.listeners) listener(settings);
  });
}

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    copyText,
    getApplicationSettings: () => Promise.resolve(applicationSettings.current),
    onApplicationSettingsChanged: (listener: (settings: unknown) => void) => {
      applicationSettings.listeners.add(listener);
      return () => applicationSettings.listeners.delete(listener);
    },
  }),
}));

const workstream: WorkstreamDetail = {
  id: 'workstream-1',
  title: 'Monday invoice review',
  titleStatus: 'settled' as const,
  emailAddress: 'luminous-tidal-structured-curie@automation.rallywith.ai',
  origin: 'automation',
  automationName: 'Weekly invoice monitor',
  harnessStatus: 'completed',
  scope: 'workspace' as const,
  lastActivityAt: '2026-07-31T20:00:12.000Z',
  latestAttentionSequenceNumber: 4,
  readThroughSequenceNumber: 4,
  manualUnreadFromSequenceNumber: null,
  manualUnreadGeneration: 0,
  hasUnread: false,
  firstUnreadSequenceNumber: null,
  nextPendingWakeup: null,
  pinPosition: null,
  plannedFor: '2026-08-03T16:00:00.000Z',
  createdAt: '2026-07-31T20:00:00.000Z',
  participants: [],
  viewers: [],
  resources: [],
  connections: [],
  backgroundTasks: [],
  automationRuns: [],
  automationSubscriptionId: 'subscription-1',
  automationSubscription: {
    id: 'subscription-1',
    name: 'Weekly invoice monitor',
    scope: 'workspace',
    status: 'active',
    triggerSummary: 'Every Monday at 9:00 AM',
    executionScope: 'Workspace',
  },
  automationRunId: 'automation-run-1',
  latestHarnessRunId: 'harness-run-1',
  latestHarnessRun: {
    id: 'harness-run-1',
    origin: 'automation_schedule',
    status: 'completed',
    model: 'google/gemini-2.5-flash-lite',
    startedAt: '2026-07-31T20:00:00.000Z',
    completedAt: '2026-07-31T20:00:12.000Z',
    createdAt: '2026-07-31T20:00:00.000Z',
  },
};

describe('InspectorRail details', () => {
  beforeEach(() => {
    copyText.mockReset();
    copyText.mockResolvedValue(undefined);
    applicationSettings.listeners.clear();
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useUiStore.setState({
      railOpen: true,
      railVariant: 'context',
      railWidth: 360,
      inspector: null,
    });
  });

  it('steps the stored width from the handle standing beside the rail', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );
    const handle = screen.getByRole('separator', { name: 'Resize inspector' });

    expect(handle).toHaveAttribute('aria-valuenow', '360');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(useUiStore.getState().railWidth).toBe(376);

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUiStore.getState().railWidth).toBe(360);
  });

  it('shows automation-subscription and bounded harness-run metadata while debugging is on', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    expect(await screen.findByText('Every Monday at 9:00 AM')).toBeVisible();
    expect(screen.getAllByText('Weekly invoice monitor')).toHaveLength(2);
    expect(screen.getByText('subscription-1')).toBeVisible();
    expect(screen.getByText('automation-run-1')).toBeVisible();
    expect(screen.getByText('google/gemini-2.5-flash-lite')).toBeVisible();
    expect(screen.getByText('automation schedule')).toBeVisible();
    expect(screen.getByText('harness-run-1')).toBeVisible();
    expect(screen.getByText('workstream-1')).toBeVisible();
  });

  it('collapses Details to the four human-facing rows when debugging is turned off', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    const details = screen.getByText('Email').closest('dl') as HTMLElement;
    const labels = (): string[] => [...details.querySelectorAll('dt')].map((term) => term.textContent ?? '');

    // The stored preference is on, so the wiring rows have to arrive before the
    // collapse below can mean anything.
    await waitFor(() => expect(labels()).toContain('Harness run'));

    // The Settings window owns the preference, so the rail learns about a
    // change through the application-settings broadcast.
    announceApplicationSettings({ lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

    expect(labels()).toEqual(['Email', 'Created by', 'Created', 'Last activity']);
    expect(within(details).queryByText('harness-run-1')).not.toBeInTheDocument();
  });

  it('clips the address to one line in both states so the row reads the same way', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    const address = (): HTMLElement => screen.getByText(workstream.emailAddress ?? '');
    await waitFor(() => expect(screen.getByText('Origin')).toBeVisible());
    expect(address()).toHaveAttribute('title', workstream.emailAddress);

    announceApplicationSettings({ lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

    expect(address()).toHaveAttribute('title', workstream.emailAddress);
  });

  it('shows the complete work-stream email address in Details and copies it with feedback', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    const emailAddress = 'luminous-tidal-structured-curie@automation.rallywith.ai';
    expect(screen.getByText(emailAddress)).toBeVisible();

    const copyButton = screen.getByRole('button', { name: 'Copy work-stream email address' });
    expect(copyButton).toHaveAttribute('title', 'Copy work-stream email address');
    fireEvent.click(copyButton);

    expect(copyText).toHaveBeenCalledWith(emailAddress);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Work-stream email address copied' })).toHaveAttribute('title', 'Copied');
    });
  });

  it('keeps the icon copy control retryable when the clipboard rejects the write', async () => {
    copyText.mockRejectedValueOnce(new Error('clipboard unavailable'));

    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy work-stream email address' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy failed; retry work-stream email address' }))
        .toHaveAttribute('title', 'Copy failed — click to retry');
    });
    expect(screen.getByRole('status')).toHaveTextContent('could not be copied');
  });

  // The watch control sits beside the button that opens the resource, rather
  // than inside it, and the two are kept apart by sibling order and a
  // positioned overlay. These lock that arrangement in.
  const watched: WorkstreamResource = {
    id: 'resource-1',
    title: 'Linear issue create: AVA-9',
    resourceType: 'issue',
    provider: 'linear',
    watchEnabled: false,
    watchStatus: 'paused',
  };

  function renderResources(resources: WorkstreamResource[], onToggleWatch = vi.fn()): { onToggleWatch: ReturnType<typeof vi.fn> } {
    render(
      <Tooltip.Provider>
        <InspectorRail onToggleWatch={onToggleWatch} workstream={{ ...workstream, resources }} />
      </Tooltip.Provider>,
    );
    return { onToggleWatch };
  }

  it('toggles the watch without opening the resource it belongs to', () => {
    const { onToggleWatch } = renderResources([watched]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Watch' }));

    expect(onToggleWatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'resource-1' }), true);
    expect(useUiStore.getState().inspector).toBeNull();
  });

  it('opens the resource from the row without touching the watch', () => {
    const { onToggleWatch } = renderResources([watched]);

    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));

    expect(useUiStore.getState().inspector).toEqual({ type: 'resource', id: 'resource-1' });
    expect(onToggleWatch).not.toHaveBeenCalled();
  });

  it('names every watch state in full even where the row shows the short form', () => {
    renderResources([
      watched,
      { ...watched, id: 'resource-2', title: 'Watched doc', watchEnabled: true, watchStatus: 'watching' },
      { ...watched, id: 'resource-3', title: 'Local note', provider: 'fixture', watchStatus: 'unsupported' },
      { ...watched, id: 'resource-4', title: 'Stale issue', watchStatus: 'error' },
    ]);

    expect(screen.getByRole('checkbox', { name: 'Watch' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Watching' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Watch unavailable' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Watch needs attention' })).toBeEnabled();
    expect(screen.getByText('Unavailable')).toBeVisible();
    expect(screen.getByText('Needs attention')).toBeVisible();
  });

  it('keeps the watch control out of the button that opens the resource', () => {
    renderResources([{ ...watched, watchStatus: 'unsupported' }]);

    const checkbox = screen.getByRole('checkbox', { name: 'Watch unavailable' });
    expect(checkbox).toBeDisabled();
    // Nesting the label back inside the button would send its clicks to the
    // resource instead of the checkbox, which is the arrangement this row
    // exists to avoid. jsdom has no layout, so the overlay that widens the
    // button's hit area back over the whole row is checked in a real engine.
    expect(screen.getByRole('button', { name: /Linear issue create: AVA-9/ })).not.toContainElement(checkbox);
  });

});
