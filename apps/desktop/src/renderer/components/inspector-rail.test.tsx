import { fireEvent, render, screen, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, WorkstreamDetail } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { InspectorRail } from './inspector-rail';

const workstream: WorkstreamDetail = {
  id: 'workstream-1',
  title: 'Monday invoice review',
  origin: 'automation',
  automationName: 'Weekly invoice monitor',
  harnessStatus: 'completed',
  lastActivityAt: '2026-07-31T20:00:12.000Z',
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

  it('shows automation-subscription and bounded harness-run metadata', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    expect(screen.getAllByText('Weekly invoice monitor')).toHaveLength(2);
    expect(screen.getByText('Every Monday at 9:00 AM')).toBeVisible();
    expect(screen.getByText('subscription-1')).toBeVisible();
    expect(screen.getByText('automation-run-1')).toBeVisible();
    expect(screen.getByText('google/gemini-2.5-flash-lite')).toBeVisible();
    expect(screen.getByText('automation schedule')).toBeVisible();
    expect(screen.getByText('harness-run-1')).toBeVisible();
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
