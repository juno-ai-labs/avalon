import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSession } from '../../common/desktop';
import type { BackgroundTask, ElicitationData, HarnessRunMetadata, Message, WorkstreamDetail, WorkstreamResource } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import {
  AddResourceDialog,
  highestVisibleAttentionSequence,
  initialTranscriptAnchorIndex,
  JumpToLatestButton,
  manualElicitationResponse,
  mergeBackgroundTasks,
  RunFailureNotice,
  WorkstreamErrorState,
  WorkstreamHeader,
  workstreamRunTiming,
  workspaceMemberFromSession,
} from './workstream';

const copyText = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn());

vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ copyText, getRuntimeConfig }) }));

const headerWorkstream: WorkstreamDetail = {
  id: 'workstream-header',
  title: 'Daily product brief',
  origin: 'automation',
  automationName: 'Daily monitor',
  harnessStatus: 'completed',
  lastActivityAt: '2026-08-07T12:00:00.000Z',
  latestAttentionSequenceNumber: 0,
  readThroughSequenceNumber: 0,
  manualUnreadFromSequenceNumber: null,
  manualUnreadGeneration: 0,
  hasUnread: false,
  firstUnreadSequenceNumber: null,
  createdAt: '2026-08-07T12:00:00.000Z',
  participants: [],
  viewers: [],
  resources: [],
  connections: [],
  artifacts: [],
  backgroundTasks: [],
  automationRuns: [],
};

function renderWorkstreamHeader(
  workstream = headerWorkstream,
  overrides: { hypersightOpen?: boolean; onToggleHyperSight?: () => void } = {},
): ReturnType<typeof render> {
  return render(
    <Tooltip.Provider>
      <WorkstreamHeader
        hypersightOpen={overrides.hypersightOpen ?? false}
        hypersightPreferencePending={false}
        onAddParticipant={vi.fn()}
        // The screen opens the rail through the same store action, after
        // giving up the right sidebar's other occupant.
        onOpenRail={(variant) => useUiStore.getState().openRail(variant)}
        onToggleHyperSight={overrides.onToggleHyperSight ?? vi.fn()}
        socketState="connected"
        workstream={workstream}
      />
    </Tooltip.Provider>,
  );
}

describe('WorkstreamHeader origin affordances', () => {
  beforeEach(() => {
    useUiStore.setState({ railOpen: false, railVariant: 'context', inspector: null });
  });

  it('copies the canonical HTTPS link, which survives being pasted outside Avalon', async () => {
    const workstreamId = '019fec70-fba0-7b0e-9f7a-3dd1ef56520f';
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    copyText.mockReset();
    copyText.mockResolvedValue(undefined);
    getRuntimeConfig.mockResolvedValue({
      appVersion: 'test',
      isPackaged: true,
      platform: 'darwin',
      api: { global: 'https://api.with-avalon.com', eu: 'https://eu.api.with-avalon.com' },
      webBaseUrl: 'https://with-avalon.com',
      devAuthEnabled: false,
    });
    renderWorkstreamHeader({ ...headerWorkstream, id: workstreamId });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More work-stream actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy work-stream link' }));

    await waitFor(() => expect(copyText).toHaveBeenCalledWith(
      `https://with-avalon.com/app/workstreams/${workstreamId}`,
    ));
    expect(copyText).not.toHaveBeenCalledWith(expect.stringContaining('avalon://'));
  });

  it('removes origin icons while preserving automation runs in the More menu', async () => {
    renderWorkstreamHeader();

    expect(document.querySelector('.header-origin-icon')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Automation runs' })).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More work-stream actions' }), {
      button: 0,
      ctrlKey: false,
    });
    const runsItem = await screen.findByRole('menuitem', { name: 'Automation runs' });
    expect(runsItem.querySelector('svg')).toBeNull();

    fireEvent.click(runsItem);
    expect(useUiStore.getState()).toMatchObject({ railOpen: true, railVariant: 'runs' });
  });

  it('marks the panel holding the right sidebar as open and closes it from there', () => {
    renderWorkstreamHeader();

    const context = screen.getByRole('button', { name: 'Work-stream context' });
    expect(context).toHaveAttribute('aria-pressed', 'false');
    expect(context).not.toHaveClass('is-active');

    fireEvent.click(context);
    expect(useUiStore.getState()).toMatchObject({ railOpen: true, railVariant: 'context' });
    const openContext = screen.getByRole('button', { name: 'Hide work-stream context' });
    expect(openContext).toHaveAttribute('aria-pressed', 'true');
    expect(openContext).toHaveClass('is-active');
    // The sidebar holds one panel at a time, so the other control stays unpressed.
    expect(screen.getByRole('button', { name: 'Background tasks' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(openContext);
    expect(useUiStore.getState().railOpen).toBe(false);
    expect(screen.getByRole('button', { name: 'Work-stream context' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows HyperSight as the open panel while it holds the sidebar', () => {
    const onToggleHyperSight = vi.fn();
    renderWorkstreamHeader(headerWorkstream, { hypersightOpen: true, onToggleHyperSight });

    const hypersight = screen.getByRole('button', { name: 'Hide HyperSight' });
    expect(hypersight).toHaveAttribute('aria-pressed', 'true');
    expect(hypersight).toHaveClass('is-active');
    expect(screen.getByRole('button', { name: 'Work-stream context' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(hypersight);
    expect(onToggleHyperSight).toHaveBeenCalledTimes(1);
  });

  it('does not expose automation runs or an origin icon for ad-hoc work streams', async () => {
    renderWorkstreamHeader({ ...headerWorkstream, origin: 'ad_hoc' });

    expect(document.querySelector('.header-origin-icon')).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More work-stream actions' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.queryByRole('menuitem', { name: 'Automation runs' })).not.toBeInTheDocument();
  });
});

const transcript: Message[] = [
  {
    id: 'message-one',
    workstreamId: 'workstream-one',
    sequenceNumber: 1,
    authorType: 'human',
    messageType: 'text',
    text: 'Start',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'message-two',
    workstreamId: 'workstream-one',
    sequenceNumber: 2,
    authorType: 'agent',
    messageType: 'tool_event',
    createdAt: '2026-08-01T00:00:01.000Z',
  },
  {
    id: 'message-three',
    workstreamId: 'workstream-one',
    sequenceNumber: 3,
    authorType: 'agent',
    messageType: 'text',
    text: 'Done',
    createdAt: '2026-08-01T00:00:02.000Z',
  },
];

describe('transcript read positioning', () => {
  it('opens one message before the first unread sequence to preserve context', () => {
    expect(initialTranscriptAnchorIndex(transcript, 3)).toBe(1);
    expect(initialTranscriptAnchorIndex(transcript, 1)).toBe(0);
    expect(initialTranscriptAnchorIndex(transcript, null)).toBeNull();
  });

  it('acknowledges visible attention messages but ignores tool and transient rows', () => {
    expect(highestVisibleAttentionSequence(transcript, [0, 1], 3)).toBe(1);
    expect(highestVisibleAttentionSequence(transcript, [1, 2], 3)).toBe(3);
    expect(highestVisibleAttentionSequence([
      ...transcript,
      { ...transcript[2]!, id: 'transient', sequenceNumber: 4 },
    ], [3], 3)).toBe(0);
  });
});

const openElicitation: ElicitationData = {
  id: 'elicitation-one',
  prompt: 'What should Avalon do?',
  responseType: 'single_select',
  options: [{ label: 'Review it', value: 'review' }],
  minimumSelections: 1,
  maximumSelections: 1,
  status: 'open',
};

const harnessRun: HarnessRunMetadata = {
  id: 'run-one',
  origin: 'message',
  status: 'running',
  startedAt: '2026-08-05T12:00:00.000Z',
  createdAt: '2026-08-05T11:59:59.000Z',
};

describe('workstreamRunTiming', () => {
  it('adapts the current harness run to the shared live work timer', () => {
    expect(workstreamRunTiming('running', harnessRun)).toEqual({
      active: true,
      durationMs: 0,
      startedAt: Date.parse('2026-08-05T12:00:00.000Z'),
    });
  });

  it('retains the canonical elapsed time after the turn completes', () => {
    expect(workstreamRunTiming('completed', {
      ...harnessRun,
      status: 'completed',
      completedAt: '2026-08-05T12:01:23.000Z',
    })).toEqual({ active: false, durationMs: 83_000 });
  });

  it('does not describe a run awaiting input as completed work', () => {
    expect(workstreamRunTiming('needs_input', {
      ...harnessRun,
      status: 'needs_input',
    })).toBeNull();
  });
});

describe('manualElicitationResponse', () => {
  it('turns a composer entry into a custom single-select response', () => {
    expect(manualElicitationResponse(openElicitation, '  Take a closer look  ')).toEqual({
      answer: 'Take a closer look',
      customResponse: 'Take a closer look',
    });
  });

  it('wraps a custom multi-select response and leaves text responses as text', () => {
    expect(manualElicitationResponse({ ...openElicitation, responseType: 'multi_select' }, 'Summarize both')).toEqual({
      answer: ['Summarize both'],
      customResponse: 'Summarize both',
    });
    expect(manualElicitationResponse({ ...openElicitation, responseType: 'text' }, 'Explain the risk')).toEqual({
      answer: 'Explain the risk',
    });
  });
});

describe('WorkstreamErrorState', () => {
  beforeEach(() => {
    copyText.mockReset();
    copyText.mockResolvedValue(undefined);
  });

  it('offers the work-stream ID from a More menu so an unopenable work stream can still be reported', async () => {
    const onRetry = vi.fn();
    render(
      <Tooltip.Provider>
        <WorkstreamErrorState description="An unexpected error occurred" onRetry={onRetry} workstreamId="workstream-unopenable" />
      </Tooltip.Provider>,
    );

    expect(screen.getByText('Work stream could not be opened')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More work-stream actions' }), {
      button: 0,
      ctrlKey: false,
    });
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Copy work-stream ID']);

    fireEvent.click(items[0]!);
    expect(copyText).toHaveBeenCalledWith('workstream-unopenable');
  });
});

describe('JumpToLatestButton', () => {
  it('is compact and icon-only while retaining an accessible action name', () => {
    const onJump = vi.fn();
    render(
      <Tooltip.Provider>
        <JumpToLatestButton onJump={onJump} />
      </Tooltip.Provider>,
    );

    const button = screen.getByRole('button', { name: 'Jump to latest' });
    expect(button).not.toHaveTextContent('Latest');
    fireEvent.click(button);
    expect(onJump).toHaveBeenCalledOnce();
  });
});

describe('RunFailureNotice', () => {
  it('shows a typed member-safe error and exposes retry and request-id actions', () => {
    const onCopyRequestId = vi.fn();
    const onRetry = vi.fn();
    render(
      <RunFailureNotice
        code="context_limit_exceeded"
        message="The run exceeded the model context window."
        onCopyRequestId={onCopyRequestId}
        onRetry={onRetry}
        requestId="run-request-123"
        retrying={false}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The run exceeded the model context window.');
    expect(screen.getByRole('alert')).toHaveTextContent('context_limit_exceeded');
    fireEvent.click(screen.getByRole('button', { name: 'Copy request ID' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onCopyRequestId).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('prevents a duplicate retry while the retry request is pending', () => {
    render(
      <RunFailureNotice
        code="provider_timeout"
        message="The provider timed out."
        onCopyRequestId={vi.fn()}
        onRetry={vi.fn()}
        retrying
      />,
    );

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });
});

describe('AddResourceDialog', () => {
  it('searches and attaches discovered connector resources while retaining upload fallback', () => {
    const resource: WorkstreamResource = {
      id: 'resource-1',
      title: 'Avalon release pull request',
      resourceType: 'github_pull_request',
      provider: 'github',
      canonicalUrl: 'https://github.com/avalon/avalon/pull/42',
      watchEnabled: false,
      watchStatus: 'paused',
    };
    const onAttach = vi.fn();
    const onSearchChange = vi.fn();
    const onUpload = vi.fn();
    render(
      <Tooltip.Provider>
        <AddResourceDialog
          current={[]}
          fetching={false}
          hasMore={false}
          loading={false}
          onAttach={onAttach}
          onLoadMore={vi.fn()}
          onOpenChange={vi.fn()}
          onSearchChange={onSearchChange}
          onUpload={onUpload}
          open
          pending={false}
          resources={[resource]}
          search=""
        />
      </Tooltip.Provider>,
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search resources' }), { target: { value: 'release' } });
    expect(onSearchChange).toHaveBeenCalledWith('release');
    fireEvent.click(screen.getByRole('button', { name: /Avalon release pull request/u }));
    expect(onAttach).toHaveBeenCalledWith(resource);
    fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
    expect(onUpload).toHaveBeenCalledOnce();
  });
});

describe('workspaceMemberFromSession', () => {
  it('uses the signed-in person for an optimistic human message in a multiplayer stream', () => {
    const session: DesktopSession = {
      accessToken: 'access-token-longer-than-twenty-characters',
      expiresAt: '2026-07-31T20:00:00.000Z',
      apiBaseUrl: 'https://api.with-avalon.com',
      user: {
        id: 'user-current',
        name: 'Current Person',
        email: 'current@example.com',
        avatarUrl: 'https://example.com/current.png',
      },
      workspace: {
        id: 'workspace-one',
        name: 'Avalon',
        region: 'global',
        role: 'member',
      },
    };

    expect(workspaceMemberFromSession(session)).toEqual({
      id: 'user-current',
      name: 'Current Person',
      email: 'current@example.com',
      avatarUrl: 'https://example.com/current.png',
      role: 'member',
      timezone: 'America/Los_Angeles',
    });
  });
});

describe('mergeBackgroundTasks', () => {
  it('keeps persisted history while allowing realtime state to replace the matching task', () => {
    const persisted: BackgroundTask[] = [
      { id: 'old', title: 'Earlier task', type: 'tool', status: 'completed', startedAt: '2026-07-31T10:00:00.000Z' },
      { id: 'current', title: 'Current task', type: 'tool', status: 'running', startedAt: '2026-08-01T10:00:00.000Z' },
    ];
    const live: BackgroundTask[] = [
      { id: 'current', title: 'Current task', type: 'tool', status: 'completed', startedAt: '2026-08-01T10:00:00.000Z' },
    ];

    expect(mergeBackgroundTasks(persisted, live)).toEqual([
      expect.objectContaining({ id: 'current', status: 'completed' }),
      expect.objectContaining({ id: 'old', status: 'completed' }),
    ]);
  });
});
