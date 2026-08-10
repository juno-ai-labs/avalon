import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApplicationSettings } from '../../common/desktop';
import type { Message, WorkstreamDetail } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { InspectorRail } from './inspector-rail';

const copyText = vi.hoisted(() => vi.fn());
const applicationSettings = vi.hoisted(() => ({
  current: { lockdownMode: false, lockdownAvailable: false, debugEnabled: false },
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
  emailAddress: 'luminous-tidal-structured-curie@automation.with-avalon.com',
  origin: 'automation',
  automationName: 'Weekly invoice monitor',
  harnessStatus: 'completed',
  lastActivityAt: '2026-07-31T20:00:12.000Z',
  latestAttentionSequenceNumber: 4,
  readThroughSequenceNumber: 4,
  manualUnreadFromSequenceNumber: null,
  manualUnreadGeneration: 0,
  hasUnread: false,
  firstUnreadSequenceNumber: null,
  plannedFor: '2026-08-03T16:00:00.000Z',
  createdAt: '2026-07-31T20:00:00.000Z',
  participants: [],
  viewers: [],
  resources: [],
  connections: [],
  artifacts: [],
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
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useUiStore.setState({
      railOpen: true,
      railVariant: 'context',
      railWidth: 360,
      railExpanded: false,
      inspector: null,
    });
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
    announceApplicationSettings({ lockdownMode: false, lockdownAvailable: false, debugEnabled: false });

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

    announceApplicationSettings({ lockdownMode: false, lockdownAvailable: false, debugEnabled: false });

    expect(address()).toHaveAttribute('title', workstream.emailAddress);
  });

  it('shows the complete work-stream email address in Details and copies it with feedback', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    const emailAddress = 'luminous-tidal-structured-curie@automation.with-avalon.com';
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

  it('keeps background activity primary and derives durable collections from real work-stream data', () => {
    const onJumpToMessage = vi.fn();
    const messages: Message[] = [
      {
        id: 'message-artifact',
        workstreamId: workstream.id,
        sequenceNumber: 4,
        authorType: 'agent',
        messageType: 'artifact',
        createdAt: '2026-07-31T20:00:08.000Z',
        artifact: {
          id: 'artifact-1',
          title: 'Invoice exceptions.csv',
          artifactType: 'CSV',
          status: 'ready',
        },
      },
    ];
    const backgroundWorkstream: WorkstreamDetail = {
      ...workstream,
      backgroundTasks: [
        {
          id: 'agent-1',
          title: 'Review invoice exceptions',
          type: 'agent',
          status: 'completed',
          startedAt: '2026-07-31T20:00:01.000Z',
          durationMs: 9_000,
          tokenCount: 1_250,
          toolUses: 3,
          transcriptMessageId: 'message-agent',
        },
        {
          id: 'tool-1',
          title: 'Read source spreadsheet',
          type: 'tool',
          status: 'running',
          startedAt: '2026-07-31T20:00:10.000Z',
        },
      ],
      resources: [
        {
          id: 'resource-1',
          title: 'July invoices.xlsx',
          resourceType: 'spreadsheet',
          provider: 'Google Drive',
          watchEnabled: false,
          watchStatus: 'paused',
        },
      ],
    };
    useUiStore.setState({ railVariant: 'background' });

    render(
      <Tooltip.Provider>
        <InspectorRail messages={messages} onJumpToMessage={onJumpToMessage} workstream={backgroundWorkstream} />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('heading', { name: 'Background tasks' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'All 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Outputs' })).toBeVisible();
    expect(within(screen.getByRole('list', { name: 'Outputs' })).getByText('Invoice exceptions.csv')).toBeVisible();
    expect(within(screen.getByRole('list', { name: 'Agent work' })).getByText('Review invoice exceptions')).toBeVisible();
    expect(within(screen.getByRole('list', { name: 'Sources' })).getByText('July invoices.xlsx')).toBeVisible();

    fireEvent.click(within(screen.getByRole('list', { name: 'Outputs' })).getByRole('button'));
    expect(onJumpToMessage).toHaveBeenCalledWith('message-artifact');

    fireEvent.click(within(screen.getByRole('list', { name: 'Sources' })).getByRole('button'));
    expect(useUiStore.getState().inspector).toEqual({ type: 'resource', id: 'resource-1' });
  });

  it('shows useful quiet empty states without dead controls', () => {
    useUiStore.setState({ railVariant: 'background' });

    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    expect(screen.getByText('No background tasks')).toBeVisible();
    expect(screen.getByText('Files and other deliverables created here will appear in this section.')).toBeVisible();
    expect(screen.getByText('Delegated agent work will appear here when this work stream needs it.')).toBeVisible();
    expect(screen.getByText('Files and links used by this work stream will appear here.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
  });

  it('shows a persisted output after reload with a real download action', () => {
    const onDownloadArtifact = vi.fn();
    useUiStore.setState({ railVariant: 'background' });
    const persisted = {
      ...workstream,
      artifacts: [{
        id: 'artifact-persisted',
        title: 'Launch brief.md',
        artifactType: 'markdown',
        previewText: '# Launch brief',
        status: 'complete',
        mimeType: 'text/markdown; charset=utf-8',
        harnessRunId: 'harness-run-1',
        createdAt: '2026-07-31T20:00:10.000Z',
      }],
    };

    render(
      <Tooltip.Provider>
        <InspectorRail onDownloadArtifact={onDownloadArtifact} workstream={persisted} />
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download Launch brief.md' }));
    expect(onDownloadArtifact).toHaveBeenCalledWith(expect.objectContaining({ id: 'artifact-persisted' }));
  });
});
