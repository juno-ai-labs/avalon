import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSummarySchema, WORKSTREAM_NAMING_GRACE_MS } from '@rally/contracts';
import type { DesktopApplicationSettings } from '../../common/desktop';
import type { AutomationSummary, NoteSummary, Workspace, WorkstreamSummary } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { useUiStore } from '../lib/ui-store';
import { REVEAL_DEADLINE_MS, Sidebar } from './sidebar';

const copyText = vi.hoisted(() => vi.fn());
const openSettings = vi.hoisted(() => vi.fn());
const openSidekicks = vi.hoisted(() => vi.fn());
const reportTelemetryProductIntent = vi.hoisted(() => vi.fn());
const markWorkstreamNavigation = vi.hoisted(() => vi.fn());
const markSurfaceEntrypoint = vi.hoisted(() => vi.fn());
const markWorkstreamFeedOpenStarted = vi.hoisted(() => vi.fn());
const startWorkstreamSocketWarmup = vi.hoisted(() => vi.fn());
const cancelWorkstreamSocketWarmup = vi.hoisted(() => vi.fn());
const workstreamSocketOpenContext = vi.hoisted(() => vi.fn((workstreamId: string): {
  state: 'retained_pair' | 'control_warmup' | 'cold';
  socketLeaseId?: string;
} => {
  void workstreamId;
  return { state: 'cold' };
}));
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
    openSettings,
    openSidekicks,
    getRuntimeConfig: () => Promise.resolve({ webBaseUrl: 'https://rallywith.ai' }),
    getApplicationSettings: () => Promise.resolve(applicationSettings.current),
    onApplicationSettingsChanged: (listener: (settings: unknown) => void) => {
      applicationSettings.listeners.add(listener);
      return () => applicationSettings.listeners.delete(listener);
    },
  }),
}));

vi.mock('../lib/telemetry', () => ({
  markSurfaceEntrypoint,
  markWorkstreamFeedOpenStarted,
  markWorkstreamNavigation,
  reportTelemetryProductIntent,
  telemetryVisibility: (scope: string) => scope === 'workspace' ? 'public' : 'private',
}));

vi.mock('../lib/workstream-socket-pool', () => ({
  useWorkstreamSocketOpenContext: (workstreamId: string) => () => workstreamSocketOpenContext(workstreamId),
  useWorkstreamSocketHoverWarmup: (workstreamId: string) => ({
    onPointerCancel: () => cancelWorkstreamSocketWarmup(workstreamId),
    onPointerEnter: () => startWorkstreamSocketWarmup(workstreamId),
    onPointerLeave: () => cancelWorkstreamSocketWarmup(workstreamId),
  }),
}));

const workspace: Workspace = {
  id: '00000000-0000-7000-8000-000000000001',
  name: 'Rally Studio',
  region: 'global',
  timezone: 'America/Los_Angeles',
  currentUser: { id: 'user-1', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles' },
};

const defaultActions = {
  onArchiveNote: async (): Promise<void> => undefined,
  onArchiveWorkstream: async (): Promise<void> => undefined,
  onApplyWorkstreamBatch: async (): Promise<{ enqueuedCount: number; archivedNoteCount: number }> =>
    ({ enqueuedCount: 0, archivedNoteCount: 0 }),
  onChangeNoteScope: async (): Promise<void> => undefined,
  onChangeWorkstreamScope: async (): Promise<void> => undefined,
  onDeleteAutomation: async (): Promise<void> => undefined,
  onMarkWorkstreamUnread: async (): Promise<void> => undefined,
  onOpenMeetingNotes: async (): Promise<void> => undefined,
  onPreviewWorkstreamBatch: async (): Promise<{ matchedCount: number; matchedNoteCount: number }> =>
    ({ matchedCount: 0, matchedNoteCount: 0 }),
  onPinWorkstream: async (): Promise<boolean> => true,
  onReorderPinnedWorkstreams: async (): Promise<void> => undefined,
  onRenameWorkstream: async (): Promise<void> => undefined,
  onRunAutomation: async (): Promise<void> => undefined,
};

const automation: AutomationSummary = {
  id: 'automation-1',
  name: 'Daily product brief',
  description: 'A brief every morning.',
  scope: 'you',
  status: 'active',
  nextRunAt: '2026-08-01T16:00:00.000Z',
  updatedAt: '2026-07-20T09:00:00.000Z',
};

function workstream(
  id: string,
  title: string,
  harnessStatus: WorkstreamSummary['harnessStatus'],
  lastActivityAt = '2026-07-31T20:00:00.000Z',
  viewerState: Partial<Pick<WorkstreamSummary, 'hasUnread' | 'unseen' | 'youAreMentioned'>> = {},
): WorkstreamSummary {
  return {
    id,
    title,
    titleStatus: 'settled',
    harnessStatus,
    scope: 'workspace' as const,
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    nextPendingWakeup: null,
    pinPosition: null,
    participantUserIds: [],
    participantExtraCount: 0,
    lastActivityAt,
    ...viewerState,
  };
}

/** The same work stream, pinned by the viewer at `position`. */
function pinned(workstream: WorkstreamSummary, position: number): WorkstreamSummary {
  return { ...workstream, pinPosition: position };
}

function note(id: string, title: string, lastActivityAt: string): NoteSummary {
  return {
    id,
    workspaceId: '00000000-0000-4000-8000-000000000010',
    resourceId: '00000000-0000-4000-8000-000000000011',
    ownerUserId: workspace.currentUser.id,
    scope: 'personal',
    title,
    recordingStatus: 'complete',
    recordedMs: 60_000,
    startedAt: '2026-07-31T19:00:00.000Z',
    endedAt: '2026-07-31T19:01:00.000Z',
    generatedAt: null,
    lastActivityAt,
    createdAt: lastActivityAt,
    updatedAt: lastActivityAt,
    archivedAt: null,
  };
}

describe('Sidebar work-stream markers', () => {
  beforeEach(() => {
    window.localStorage.clear();
    copyText.mockReset().mockResolvedValue(undefined);
    markSurfaceEntrypoint.mockReset();
    markWorkstreamNavigation.mockReset();
    markWorkstreamFeedOpenStarted.mockReset();
    reportTelemetryProductIntent.mockReset();
    startWorkstreamSocketWarmup.mockReset();
    cancelWorkstreamSocketWarmup.mockReset();
    workstreamSocketOpenContext.mockReset().mockReturnValue({ state: 'cold' });
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true };
    applicationSettings.listeners.clear();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300 });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  it('reduces the GrokBot shell navigation to work streams', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[automation]}
            conversationOnly
            notes={[note('note-hidden', 'Meeting notes', '2026-07-31T19:00:00.000Z')]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[workstream('stream-visible', 'Customer launch', 'completed')]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByText('Customer launch')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Sidekick shortcuts' })).toContainElement(screen.getByText('Daily product brief'));
    expect(screen.queryByText('Meeting notes')).not.toBeInTheDocument();
    expect(screen.queryByText('New automation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search workspace' })).toBeInTheDocument();
    const titlebar = document.querySelector('.sidebar-titlebar');
    const commandbar = document.querySelector('.sidebar-commandbar');
    expect(titlebar).not.toBeNull();
    expect(commandbar).not.toBeNull();
    expect(titlebar).toContainElement(screen.getByRole('link', { name: 'New chat' }));
    expect(commandbar).toContainElement(screen.getByRole('button', { name: 'Search workspace' }));
    expect(commandbar?.querySelector('.sidebar-new-button')).toBeNull();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('resizes from the keyboard and exposes its constrained width', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const resizer = screen.getByRole('separator', { name: 'Resize navigation' });
    expect(resizer).toHaveAttribute('aria-valuenow', '300');

    fireEvent.keyDown(resizer, { key: 'ArrowRight' });
    expect(resizer).toHaveAttribute('aria-valuenow', '316');
    expect(window.localStorage.getItem('rally.sidebar-width')).toBe('316');

    fireEvent.keyDown(resizer, { key: 'ArrowLeft' });
    expect(resizer).toHaveAttribute('aria-valuenow', '300');
  });

  it('names compact links and connects their hover descriptions to the link', async () => {
    const item = workstream('compact-preview', 'Named compact destination', 'completed');
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} compact conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[item]} /></Tooltip.Provider></MemoryRouter>);
    const link = screen.getByRole('link', { name: item.title });
    fireEvent.pointerEnter(link.closest('[data-workstream-id]')!);
    await waitFor(() => expect(link).toHaveAttribute('aria-describedby', `workstream-preview-${item.id}`));
    expect(document.getElementById(link.getAttribute('aria-describedby')!)).toHaveTextContent(item.title);
  });

  it('forwards a work-stream row hover to the pooled socket warm-up', () => {
    const hovered = workstream('hovered-workstream', 'Warm this work stream', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[hovered]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
    const row = screen.getByText('Warm this work stream').closest('[data-workstream-id]');
    if (!row) throw new Error('The work-stream row has no hover target.');

    fireEvent.pointerEnter(row);
    expect(startWorkstreamSocketWarmup).toHaveBeenCalledWith(hovered.id);
    fireEvent.pointerLeave(row);
    expect(cancelWorkstreamSocketWarmup).toHaveBeenCalledWith(hovered.id);
    cancelWorkstreamSocketWarmup.mockClear();
    fireEvent.pointerCancel(row);
    expect(cancelWorkstreamSocketWarmup).toHaveBeenCalledWith(hovered.id);

    const socketLeaseId = '018f22f2-4c22-7abc-8def-012345678905';
    workstreamSocketOpenContext.mockReturnValue({ state: 'control_warmup', socketLeaseId });
    fireEvent.click(screen.getByRole('link', { name: /Warm this work stream/u }));
    expect(markWorkstreamFeedOpenStarted).toHaveBeenCalledWith(
      hovered.id,
      'recent',
      'control_warmup',
      expect.any(Number),
      socketLeaseId,
    );
  });

  it('shows a last-change timestamp only for unread rows and no participant stacks or Command hints', () => {
    const read = { ...workstream('read-row', 'Read destination', 'completed'), participantUserIds: ['user-1'] };
    const unread = { ...workstream('unread-row', 'Unread destination', 'completed'), hasUnread: true, preview: 'Do not display this preview' };
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[read, unread]} /></Tooltip.Provider></MemoryRouter>);
    const readLink = screen.getByRole('link', { name: read.title });
    const unreadLink = screen.getByRole('link', { name: new RegExp(unread.title, 'u') });
    expect(readLink.querySelector('time')).toBeNull();
    expect(unreadLink.querySelector('time')).toHaveAttribute('datetime', unread.lastActivityAt);
    expect(screen.queryByText(unread.preview)).not.toBeInTheDocument();
    expect(document.querySelector('.sidebar-workstream-facepile')).toBeNull();
    fireEvent.keyDown(window, { key: 'Meta', metaKey: true });
    expect(document.querySelector('.command-shortcut-pill')).toBeNull();
    expect(readLink).not.toHaveAttribute('aria-keyshortcuts');
    expect(unreadLink).not.toHaveAttribute('aria-keyshortcuts');
    fireEvent.keyDown(window, { code: 'Digit2', key: '2', metaKey: true });
    expect(readLink).not.toHaveClass('is-active');
    expect(unreadLink).not.toHaveClass('is-active');
    fireEvent.keyUp(window, { key: 'Meta' });
  });

  it('omits work-stream descriptions even when the objective is populated', () => {
    const described = {
      ...workstream('described-workstream', 'Daily competitor marketing', 'completed'),
      objective: 'Tracks competitor positioning and campaign changes.',
      preview: '',
    };
    render(
      <MemoryRouter initialEntries={['/workstreams/described-workstream']}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[described]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.queryByText('Tracks competitor positioning and campaign changes.'))
      .not.toBeInTheDocument();
  });

  it('given a project member, when the accordion opens, then the child is the same work-stream row as the recent list', () => {
    const memberId = '00000000-0000-7000-8000-0000000000e1';
    const member = {
      ...workstream(memberId, 'Ship the launch', 'completed'),
      preview: 'Draft the announcement',
    };
    const project = ProjectSummarySchema.parse({
      id: '00000000-0000-7000-8000-0000000000f2',
      name: 'Hiring',
      iconKey: 'briefcase',
      colorKey: 'blue',
      scope: 'personal',
      status: 'active',
      presentationRevision: 1,
      audienceGeneration: 1,
      lifecycleGeneration: 1,
      participants: [{ userId: '00000000-0000-7000-8000-0000000000f1', state: 'active', generation: 1 }],
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
      workstreamIds: [memberId],
    });
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            projects={[project]}
            workspace={workspace}
            workstreams={[member]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand Hiring' }));
    const rows = screen.getAllByRole('link', { name: /Ship the launch/u });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row).toHaveClass('sidebar-row', 'workstream-row');
      expect(row.querySelector('.sidebar-row-title')).toHaveTextContent('Ship the launch');
      expect(row.querySelector('.sidebar-row-hint')).toBeNull();
    }
  });

  it('does not start navigation telemetry when the active work-stream row is clicked again', () => {
    const active = workstream('active-workstream', 'Already open', 'completed');
    render(
      <MemoryRouter initialEntries={[`/workstreams/${active.id}`]}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[active]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: /Already open/u }));

    expect(markWorkstreamFeedOpenStarted).not.toHaveBeenCalled();
    expect(markWorkstreamNavigation).not.toHaveBeenCalled();
    expect(markSurfaceEntrypoint).not.toHaveBeenCalled();
  });

  // The pill answers to how near the pointer is rather than to hovering the
  // handle, so the reveal reaches 20px without the hit area having to.
  it('reveals the navigation pill once the pointer is near the edge, at any height', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const resizer = screen.getByRole('separator', { name: 'Resize navigation' });
    expect(resizer).not.toHaveClass('is-near');

    fireEvent.pointerMove(window, { clientX: 316, clientY: 780 });
    expect(resizer).toHaveClass('is-near');

    fireEvent.pointerMove(window, { clientX: 316, clientY: 90 });
    expect(resizer).toHaveClass('is-near');

    fireEvent.pointerMove(window, { clientX: 340, clientY: 400 });
    expect(resizer).not.toHaveClass('is-near');
  });

  // The handle stands in a strip beside the sidebar rather than on its edge, so
  // a grab at the far side of that strip must still move the sidebar by what
  // the pointer moves rather than snapping the edge out to meet it.
  it('drags from wherever the handle was grabbed without snapping the edge to the pointer', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const resizer = screen.getByRole('separator', { name: 'Resize navigation' });
    resizer.setPointerCapture = vi.fn();

    fireEvent.pointerDown(resizer, { clientX: 318, pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 318, pointerId: 3 });
    expect(resizer).toHaveAttribute('aria-valuenow', '300');

    fireEvent.pointerMove(window, { clientX: 358, pointerId: 3 });
    expect(resizer).toHaveAttribute('aria-valuenow', '340');

    fireEvent.pointerUp(window, { pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 400, pointerId: 3 });
    expect(resizer).toHaveAttribute('aria-valuenow', '340');
  });

  // OnboardingChecklist is disabled (demo-only, local-state-only, and had no
  // dismiss mechanism — see the commented-out render call in sidebar.tsx).
  // This guards against it silently coming back.
  // The three lists arrive in one answer now, so both regions are waiting on
  // the same round trip and both must show the shape of what is coming rather
  // than a blank panel or one grey block that collapses into a different one.
  it('holds a set of row-shaped skeletons while the one batch is in flight', () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            loading
            notes={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    // Three for the projects, then two groups of
    // four and three.
    expect(container.querySelectorAll('.skeleton-row')).toHaveLength(10);
    expect(container.querySelectorAll('.skeleton-group-label')).toHaveLength(2);
    // Said once for the whole wait, not once per section and not once per row.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText('Loading your projects, work streams and notes')).toBeInTheDocument();
    // Nothing claims the sidebar is empty while it is still arriving.
    expect(screen.queryByText('No active automations')).not.toBeInTheDocument();
    expect(screen.queryByText('No work streams or notes yet')).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            loading={false}
            notes={[note('00000000-0000-4000-8000-000000000031', 'Standup', '2026-07-31T19:00:00.000Z')]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[workstream('00000000-0000-4000-8000-000000000030', 'Launch brief', 'running')]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(container.querySelectorAll('.skeleton-row')).toHaveLength(0);
    expect(screen.getByText('Launch brief')).toBeInTheDocument();
    expect(screen.getByText('Standup')).toBeInTheDocument();
  });

  // The three lists finish at different moments. A person who already has a
  // note but no work streams sees this section's own list while the projects
  // and automations above are still placeholders, and an announcement nested in
  // the work-stream skeleton's branch would have gone with it.
  it('keeps the one loading announcement while a section that has arrived shows its list', () => {
    const { container } = render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            loading
            notes={[note('00000000-0000-4000-8000-000000000032', 'Standup', '2026-07-31T19:00:00.000Z')]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    // The note is listed, so this section shows no placeholder of its own —
    // while the projects above still do.
    expect(screen.getByText('Standup')).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton-group-label')).toHaveLength(0);
    expect(container.querySelectorAll('.skeleton-row')).toHaveLength(3);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText('Loading your projects, work streams and notes')).toBeInTheDocument();
  });

  it('does not render the disabled onboarding checklist', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('region', { name: 'Get started with Rally' })).not.toBeInTheDocument();
  });

  it('uses the compact status-dot pattern for every work stream', () => {
    render(
      <MemoryRouter initialEntries={['/workstreams/input']}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[
              workstream('input', 'Board decision', 'needs_input'),
              workstream('running', 'Pricing restructure', 'running'),
              workstream('completed', 'Missing sidebar row', 'completed'),
              workstream('scheduled', 'Monday review', 'scheduled'),
              workstream('automation', 'PostHog follow-up', 'completed'),
            ]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /Board decision/u }).querySelector('.status-needs_input .status-dot')).not.toBeNull();
    expect(screen.getByRole('link', { name: /Pricing restructure/u }).querySelector('.status-running .status-dot')).not.toBeNull();
    expect(screen.getByRole('link', { name: /Missing sidebar row/u }).querySelector('.status-completed .status-dot')).not.toBeNull();
    expect(screen.getByRole('link', { name: /Monday review/u }).querySelector('.status-scheduled .status-dot')).not.toBeNull();
    expect(screen.getByRole('link', { name: /PostHog follow-up/u }).querySelector('.status-completed .status-dot')).not.toBeNull();
    expect(document.querySelector('.sidebar-automation-marker')).toBeNull();
    expect(screen.queryByRole('img', { name: /Automation-generated/u })).not.toBeInTheDocument();
    expect(document.querySelector('.brand-lockup')).toBeNull();
    expect(document.querySelector('.sidebar-titlebar')).not.toBeNull();
  });

  it('marks a work stream this person has never opened, whatever its run is doing', async () => {
    render(
      <MemoryRouter initialEntries={['/workstreams/unseen']}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[
              workstream('unseen', 'Warehouse migration', 'running', '2026-07-31T20:00:00.000Z', {
                unseen: true,
                // Everything else is true as well, and none of it wins.
                youAreMentioned: true,
                hasUnread: true,
              }),
              workstream('running', 'Pricing restructure', 'running'),
            ]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const row = screen.getByRole('link', { name: /Warehouse migration/u });
    // The run is `running`, and the marker says the other thing: being new to
    // this reader outranks it.
    expect(row.querySelector('.status-unseen .status-dot')).not.toBeNull();
    expect(row.querySelector('.status-running')).toBeNull();
    expect(screen.getByRole('link', { name: /Pricing restructure/u }).querySelector('.status-running .status-dot')).not.toBeNull();

    const dot = row.querySelector('.status-unseen');
    if (!dot) throw new Error('the work-stream row rendered no unseen status dot');
    fireEvent.pointerMove(dot, { pointerType: 'mouse' });

    expect(await screen.findByText('New to you — you were added to this work stream and have not opened it yet.'))
      .toBeVisible();
  });

  it('marks a mention above the run, and unread below it', () => {
    render(
      <MemoryRouter initialEntries={['/workstreams/mentioned']}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[
              workstream('mentioned', 'Launch blockers', 'running', '2026-07-31T20:00:00.000Z', {
                youAreMentioned: true,
                hasUnread: true,
              }),
              workstream('unread', 'Vendor contract', 'running', '2026-07-31T20:00:00.000Z', {
                hasUnread: true,
              }),
              workstream('read', 'Release notes', 'completed', '2026-07-31T20:00:00.000Z', {
                hasUnread: true,
              }),
            ]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    // Being named outranks the run that is working; merely being unread does not.
    expect(screen.getByRole('link', { name: /Launch blockers/u }).querySelector('.status-mentioned .status-dot'))
      .not.toBeNull();
    expect(screen.getByRole('link', { name: /Vendor contract/u }).querySelector('.status-running .status-dot'))
      .not.toBeNull();
    expect(screen.getByRole('link', { name: /Release notes/u }).querySelector('.status-unread .status-dot'))
      .not.toBeNull();
  });

  it('shows the next active timer and its brief prompt in a tooltip', async () => {
    const dueAt = '2026-08-13T20:30:00.000Z';
    const waiting = {
      ...workstream('waiting', 'Wait for the deploy', 'completed'),
      nextPendingWakeup: {
        dueAt,
        promptPreview: 'Check whether production deploy completed…',
      },
    };
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[waiting, workstream('finished', 'Deploy finished', 'completed')]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const accessibleTimerLabel = `Active timer. Next: ${formatDateTime(dueAt)}. Check whether production deploy completed…`;
    const marker = within(screen.getByRole('link', { name: /Wait for the deploy/u }))
      .getByRole('img', { name: accessibleTimerLabel });
    expect(marker).toHaveClass('sidebar-workstream-timer');
    expect(within(screen.getByRole('link', { name: /Deploy finished/u }))
      .queryByRole('img', { name: /Active timer/u })).not.toBeInTheDocument();

    fireEvent.pointerMove(marker, { pointerType: 'mouse' });
    expect(await screen.findByText(`Next: ${formatDateTime(dueAt)}`)).toBeVisible();
    expect(screen.getByText('Check whether production deploy completed…')).toBeVisible();
  });

  it('waits for a name rather than showing the request a work stream was created from', () => {
    const naming = {
      ...workstream('naming', 'Create an email draft to Danny from Mucker that…', 'running'),
      titleStatus: 'naming' as const,
      // A work stream is named seconds after it is created, which is the only
      // time the skeleton is shown; the fixture's own date is days old, and
      // past the grace the provisional title is the title.
      createdAt: new Date().toISOString(),
    };
    render(
      <MemoryRouter initialEntries={['/workstreams/naming']}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[naming, workstream('named', 'Board decision', 'needs_input')]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const row = screen.getByRole('link', { name: /naming this work stream/u });
    expect(row.querySelector('.title-skeleton')).not.toBeNull();
    expect(row.textContent).not.toContain('Create an email draft');
    // A settled title is text, not a skeleton — the placeholder is only for the
    // second or so before Rally answers.
    expect(screen.getByRole('link', { name: /Board decision/u }).querySelector('.title-skeleton')).toBeNull();
  });

  it('gives up on a name that never arrives rather than shimmering for the session', () => {
    vi.useFakeTimers();
    try {
      const created = new Date('2026-08-07T12:00:00.000Z');
      vi.setSystemTime(created);
      const naming = {
        ...workstream('naming', "let's talk about rally pricing", 'running'),
        titleStatus: 'naming' as const,
        createdAt: created.toISOString(),
      };
      // A row that cannot say when it was created cannot say the promise is
      // still live, so it shows the title it has from the start.
      const undated = {
        ...workstream('undated', 'Reconcile the July invoices', 'running'),
        titleStatus: 'naming' as const,
      };
      render(
        <MemoryRouter>
          <Tooltip.Provider>
            <Sidebar
              {...defaultActions}
              automations={[]}
              onSignOut={vi.fn()}
              workspace={workspace}
              workstreams={[naming, undated]}
            />
          </Tooltip.Provider>
        </MemoryRouter>,
      );

      expect(screen.getByRole('link', { name: /naming this work stream/u })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /July invoices/u })
        .querySelector('.title-skeleton')).toBeNull();

      // A row is a cache entry the sockets push into, and nothing refetches the
      // sidebar on its own — so a rename that never reached this client would
      // otherwise leave the row pulsing until the window is reopened. Somebody
      // who is a participant in a work stream and has not opened it has no
      // other repair path at all.
      act(() => { vi.advanceTimersByTime(WORKSTREAM_NAMING_GRACE_MS + 1_000); });

      const row = screen.getByRole('link', { name: /rally pricing/u });
      expect(row.querySelector('.title-skeleton')).toBeNull();
      expect(row.textContent).toContain("let's talk about rally pricing");
    } finally {
      vi.useRealTimers();
    }
  });

  it('explains a work-stream dot color on hover', async () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[workstream('input', 'Board decision', 'needs_input')]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const dot = screen.getByRole('link', { name: /Board decision/u }).querySelector('.status-needs_input');
    if (!dot) throw new Error('the work-stream row rendered no needs-input status dot');
    fireEvent.pointerMove(dot, { pointerType: 'mouse' });

    expect(await screen.findByText('Needs input — the agent is waiting on an answer.')).toBeVisible();
  });

  it('renders only populated recency sections and keeps status from changing row order', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T20:00:00.000Z'));

    try {
      render(
        <MemoryRouter>
          <Tooltip.Provider>
            <Sidebar
              {...defaultActions}
              automations={[]}
              onSignOut={vi.fn()}
              workspace={workspace}
              workstreams={[
                workstream('old-input', 'Old input request', 'needs_input', '2026-06-12T12:00:00.000Z'),
                workstream('month-scheduled', 'Scheduled this month', 'scheduled', '2026-07-10T12:00:00.000Z'),
                workstream('week-scheduled', 'Scheduled this week', 'scheduled', '2026-07-27T12:00:00.000Z'),
                workstream('yesterday-failed', 'Failed yesterday', 'failed', '2026-07-30T12:00:00.000Z'),
                workstream('day-running', 'Recently running', 'running', '2026-07-31T08:00:00.000Z'),
                workstream('hour-complete', 'Just completed', 'completed', '2026-07-31T19:50:00.000Z'),
              ]}
            />
          </Tooltip.Provider>
        </MemoryRouter>,
      );

      expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
        'Last hour',
        'Today',
        'Yesterday',
        'This week',
        'This month',
        'Before this month',
      ]);
      expect(screen.queryByRole('heading', { name: 'Work streams' })).not.toBeInTheDocument();
      expect([...document.querySelectorAll('.workstream-row .sidebar-row-title-copy')].map((row) => row.textContent)).toEqual([
        'Just completed',
        'Recently running',
        'Failed yesterday',
        'Scheduled this week',
        'Scheduled this month',
        'Old input request',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['Mark all as read', 'mark_read', 'marked as read'],
    ['Archive all', 'archive', 'archived'],
  ] as const)('confirms the %s grouping action with the server-side total', async (
    menuLabel,
    updateKind,
    resultCopy,
  ) => {
    const onPreviewWorkstreamBatch = vi.fn(async () => ({ matchedCount: 20, matchedNoteCount: 0 }));
    const onApplyWorkstreamBatch = vi.fn(async () => ({ enqueuedCount: 20, archivedNoteCount: 0 }));
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onApplyWorkstreamBatch={onApplyWorkstreamBatch}
            onPreviewWorkstreamBatch={onPreviewWorkstreamBatch}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[workstream('recent', 'Recent planning', 'completed', new Date().toISOString())]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Last hour actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: menuLabel }));

    const dialog = await screen.findByRole('dialog', { name: menuLabel });
    await waitFor(() => expect(dialog).toHaveTextContent(
      new RegExp(`20 work streams.*will be ${resultCopy}`, 'u'),
    ));
    expect(onPreviewWorkstreamBatch).toHaveBeenCalledWith(expect.objectContaining({
      pinned: false,
      includeSystem: false,
      lastActivityAt: expect.objectContaining({ atOrAfter: expect.any(String) }),
    }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onApplyWorkstreamBatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pinned: false, includeSystem: false }),
      { kind: updateKind },
    ));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: menuLabel })).not.toBeInTheDocument());
  });

  it('names the notes a grouping archive will take, and seeds the count from the rows it can see', async () => {
    // The defect: **Archive all** under a heading emptied the work streams and
    // left the notes, so the group came back half full. The dialog has to say
    // both halves are going, or agreeing to it means something else.
    // Held open, so the seed the menu computed is still on screen to assert on:
    // the server's count replaces it the moment the preview lands.
    let landPreview!: (counts: { matchedCount: number; matchedNoteCount: number }) => void;
    const onPreviewWorkstreamBatch = vi.fn(() => new Promise<{
      matchedCount: number;
      matchedNoteCount: number;
    }>((resolve) => {
      landPreview = resolve;
    }));
    const onApplyWorkstreamBatch = vi.fn(async () => ({ enqueuedCount: 4, archivedNoteCount: 2 }));
    const at = new Date().toISOString();
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[
              note('00000000-0000-4000-8000-0000000000a1', 'Kickoff', at),
              note('00000000-0000-4000-8000-0000000000a2', 'Retro', at),
              // Neither of these is this reader's to archive, so neither may be
              // counted: the server will not take them either.
              {
                ...note('00000000-0000-4000-8000-0000000000a3', 'Somebody else\'s', at),
                ownerUserId: '00000000-0000-4000-8000-0000000000ff',
                scope: 'workspace',
              },
              {
                ...note('00000000-0000-4000-8000-0000000000a4', 'Still recording', at),
                recordingStatus: 'recording',
              },
            ]}
            onApplyWorkstreamBatch={onApplyWorkstreamBatch}
            onPreviewWorkstreamBatch={onPreviewWorkstreamBatch}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[workstream('recent', 'Recent planning', 'completed', at)]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Last hour actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive all' }));

    const dialog = await screen.findByRole('dialog', { name: 'Archive all' });
    // Two of the four notes on screen, before the server has answered.
    expect(dialog).toHaveTextContent('1 work stream and 2 notes');

    act(() => landPreview({ matchedCount: 4, matchedNoteCount: 2 }));
    await waitFor(() => expect(dialog).toHaveTextContent(
      /4 work streams and 2 notes.*will be archived/u,
    ));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onApplyWorkstreamBatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pinned: false, includeSystem: false }),
      { kind: 'archive' },
    ));
  });

  it('offers no notes when a grouping is only being marked as read', async () => {
    // A note has no read state to clear, so naming one here would promise
    // something that cannot happen.
    const onPreviewWorkstreamBatch = vi.fn(async () => ({ matchedCount: 4, matchedNoteCount: 2 }));
    const at = new Date().toISOString();
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[note('00000000-0000-4000-8000-0000000000b1', 'Kickoff', at)]}
            onPreviewWorkstreamBatch={onPreviewWorkstreamBatch}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[workstream('recent', 'Recent planning', 'completed', at)]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Last hour actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark all as read' }));

    const dialog = await screen.findByRole('dialog', { name: 'Mark all as read' });
    await waitFor(() => expect(dialog).toHaveTextContent(
      /4 work streams in.*will be marked as read/u,
    ));
    expect(dialog).not.toHaveTextContent('note');
  });

  it('keeps one operation id when a failed Queue dispatch is retried', async () => {
    const onApplyWorkstreamBatch = vi.fn()
      .mockRejectedValueOnce(new Error('One Queue chunk was not published.'))
      .mockResolvedValueOnce({ enqueuedCount: 20, archivedNoteCount: 0 });
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onApplyWorkstreamBatch={onApplyWorkstreamBatch}
            onPreviewWorkstreamBatch={vi.fn(async () => ({ matchedCount: 20, matchedNoteCount: 0 }))}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[workstream('recent', 'Recent planning', 'completed', new Date().toISOString())]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Last hour actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive all' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive all' });
    await waitFor(() => expect(dialog).toHaveTextContent('20 work streams'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(dialog).toHaveTextContent('One Queue chunk was not published.'));
    const retry = within(dialog).getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(onApplyWorkstreamBatch).toHaveBeenCalledTimes(2));

    expect(onApplyWorkstreamBatch.mock.calls[1]?.[0]).toBe(onApplyWorkstreamBatch.mock.calls[0]?.[0]);
  });

  it('moves a row at its recency boundary and previews with the new clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T20:00:00.000Z'));
    const onPreviewWorkstreamBatch = vi.fn(async () => ({ matchedCount: 1, matchedNoteCount: 0 }));
    try {
      render(
        <MemoryRouter>
          <Tooltip.Provider>
            <Sidebar
              {...defaultActions}
              automations={[]}
              onPreviewWorkstreamBatch={onPreviewWorkstreamBatch}
              onSignOut={vi.fn()}
              workspace={workspace}
              workstreams={[workstream(
                'boundary',
                'Boundary planning',
                'completed',
                '2026-07-31T19:00:30.000Z',
              )]}
            />
          </Tooltip.Provider>
        </MemoryRouter>,
      );
      expect(screen.getByRole('heading', { name: 'Last hour' })).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(30_002));

      expect(screen.queryByRole('heading', { name: 'Last hour' })).not.toBeInTheDocument();
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Today actions' }), {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.click(screen.getByRole('menuitem', { name: 'Mark all as read' }));
      expect(onPreviewWorkstreamBatch).toHaveBeenCalledWith(expect.objectContaining({
        lastActivityAt: expect.objectContaining({
          before: '2026-07-31T19:00:30.002Z',
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps compact search and creation above the scrolling streams', () => {
    const onOpenSearch = vi.fn();
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} compact conversationOnly automations={[]} onOpenSearch={onOpenSearch} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    const search = screen.getByRole('button', { name: 'Search workspace' });
    const create = screen.getByRole('link', { name: 'New chat' });
    const navigation = screen.getByRole('navigation');
    expect(search.closest('.sidebar-scroll')).toBeNull();
    expect(create.closest('.sidebar-scroll')).toBeNull();
    expect(search.compareDocumentPosition(navigation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create.compareDocumentPosition(navigation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(search);
    expect(onOpenSearch).toHaveBeenCalledOnce();
    expect(create).toHaveAttribute('href', '/workstreams/new');
  });

  it.each([false, true])('shows only enabled standalone Sidekicks and opens their library detail (compact=%s)', (compact) => {
    const shared = { ...automation, loadable: false, id: 'shared', name: 'Team brief', scope: 'workspace' as const };
    const excluded = [
      { ...automation, id: 'paused', name: 'Paused helper', status: 'paused' as const },
      { ...automation, id: 'draft', name: 'Draft helper', status: 'draft' as const },
      { ...automation, id: 'room', name: 'Room helper', scope: 'workstream' as const },
    ];
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} compact={compact} conversationOnly automations={[{ ...automation, loadable: true }, shared, ...excluded]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    const strip = screen.getByRole('region', { name: 'Sidekick shortcuts' });
    expect(strip.closest('.sidebar-scroll')).toBeNull();
    expect(strip.nextElementSibling).toBe(screen.getByRole('button', { name: 'Open account menu' }));
    expect(within(strip).getAllByRole('button')).toHaveLength(2);
    for (const item of excluded) expect(screen.queryByText(item.name)).toBeNull();
    fireEvent.click(within(strip).getByRole('button', { name: 'Team brief, Active · Workspace' }));
    expect(openSidekicks).toHaveBeenCalledWith('shared');
    expect(screen.queryByRole('link', { name: /Daily product brief/u })).toBeNull();
  });

  it('omits the Sidekick strip when none are enabled', () => {
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[{ ...automation, status: 'paused' }]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    expect(screen.queryByRole('region', { name: 'Sidekick shortcuts' })).toBeNull();
  });

  it('manages Sidekicks through the library instead of listing them in the sidebar', () => {
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[automation]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    expect(screen.queryByRole('region', { name: 'Automations' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'New automation' })).toBeNull();
    expect(screen.getByRole('link', { name: 'New work stream' })).toHaveAttribute('href', '/workstreams/new');
  });

  it('opens meeting notes from the primary actions', async () => {
    const onOpenMeetingNotes = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            meetingRecordingAvailable
            onOpenMeetingNotes={onOpenMeetingNotes}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New meeting/notes' }));
    await waitFor(() => expect(onOpenMeetingNotes).toHaveBeenCalledTimes(1));
  });

  it('removes the meeting action when Meeting Recording Enabled is false', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            meetingRecordingAvailable={false}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'New meeting/notes' })).not.toBeInTheDocument();
  });

  it('sorts notes inline with work streams and opens them with a gray note marker', async () => {
    const onOpenMeetingNotes = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[
              note('00000000-0000-4000-8000-000000000021', 'Customer interview', '2026-07-31T19:55:00.000Z'),
              {
                ...note('00000000-0000-4000-8000-000000000022', 'Shared research', '2026-07-31T19:45:00.000Z'),
                scope: 'workspace',
              },
            ]}
            onOpenMeetingNotes={onOpenMeetingNotes}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[workstream('older', 'Older work stream', 'completed', '2026-07-31T19:40:00.000Z')]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect([...document.querySelectorAll('.sidebar-row-title')].map((row) => row.querySelector('.sidebar-row-title-copy')?.textContent ?? row.textContent)).toEqual([
      'Customer interview',
      'Shared research',
      'Older work stream',
    ]);
    const noteLink = screen.getByRole('link', { name: /Customer interview/u });
    expect(noteLink).toHaveAttribute('href', '/notes/00000000-0000-4000-8000-000000000021');
    expect(within(noteLink).getByRole('img', { name: 'Note' })).toHaveClass('sidebar-note-marker');
    expect(within(noteLink).getByRole('img', { name: 'Private note' })).toHaveClass('sidebar-note-privacy');
    expect(within(screen.getByRole('link', { name: /Shared research/u })).queryByRole('img', { name: 'Private note' }))
      .not.toBeInTheDocument();
    fireEvent.click(noteLink);
    expect(onOpenMeetingNotes).not.toHaveBeenCalled();
  });

  it('archives a private note from its right-click menu and offers to publish it', async () => {
    const onArchiveNote = vi.fn(async () => undefined);
    const onChangeNoteScope = vi.fn(async () => undefined);
    const target = note('00000000-0000-4000-8000-000000000031', 'Customer interview', '2026-07-31T19:55:00.000Z');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[target]}
            onArchiveNote={onArchiveNote}
            onChangeNoteScope={onChangeNoteScope}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Customer interview/u }), { clientX: 120, clientY: 90 });

    // A private note offers the state it would move to, never the one it is in.
    expect(await screen.findByRole('menuitem', { name: 'Make public to workspace' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Make private' })).not.toBeInTheDocument();
    const archive = screen.getByRole('menuitem', { name: 'Archive note' });
    expect(archive).toHaveClass('menu-item-danger');
    expect(archive).not.toHaveAttribute('data-disabled');
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Make public to workspace' }));
    await waitFor(() => expect(onChangeNoteScope).toHaveBeenCalledWith(target, 'workspace'));
    await waitFor(() => expect(reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'note_action_completed', noteId: target.id, action: 'make_public',
      visibility: 'public', recordingState: 'complete',
    }));

    // Archiving is not reversible from any surface, so it confirms first and
    // names the note it would take away.
    fireEvent.contextMenu(screen.getByRole('link', { name: /Customer interview/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive note' }));
    expect(onArchiveNote).not.toHaveBeenCalled();

    const confirm = await screen.findByRole('dialog', { name: 'Archive note' });
    expect(within(confirm).getByText('Customer interview')).toBeVisible();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive note' })).not.toBeInTheDocument());
    expect(onArchiveNote).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByRole('link', { name: /Customer interview/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive note' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Archive note' })).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(onArchiveNote).toHaveBeenCalledWith(target));
    await waitFor(() => expect(reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'note_action_completed', noteId: target.id, action: 'archive',
      visibility: 'private', recordingState: 'complete',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive note' })).not.toBeInTheDocument());
  });

  it('waits for a recording to end before it will archive the note', async () => {
    const onArchiveNote = vi.fn(async () => undefined);
    const onChangeNoteScope = vi.fn(async () => undefined);
    const target: NoteSummary = {
      ...note('00000000-0000-4000-8000-000000000036', 'Live standup', '2026-07-31T19:58:00.000Z'),
      recordingStatus: 'recording',
    };
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[target]}
            onArchiveNote={onArchiveNote}
            onChangeNoteScope={onChangeNoteScope}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Live standup/u }), { clientX: 120, clientY: 90 });

    // Archiving mid-recording would 404 the meeting window's next segment save
    // and quietly drop the rest of the transcript.
    const archive = await screen.findByRole('menuitem', { name: 'Archive note' });
    expect(archive).toHaveAttribute('data-disabled');
    fireEvent.click(archive);
    expect(onArchiveNote).not.toHaveBeenCalled();

    // The visibility of a note being recorded is still the owner's to change.
    const visibility = screen.getByRole('menuitem', { name: 'Make public to workspace' });
    expect(visibility).not.toHaveAttribute('data-disabled');
    fireEvent.click(visibility);
    await waitFor(() => expect(onChangeNoteScope).toHaveBeenCalledWith(target, 'workspace'));
  });

  it('offers a public note the way back to private', async () => {
    const onChangeNoteScope = vi.fn(async () => undefined);
    const target: NoteSummary = {
      ...note('00000000-0000-4000-8000-000000000034', 'Launch retro', '2026-07-31T19:35:00.000Z'),
      scope: 'workspace',
    };
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[target]}
            onChangeNoteScope={onChangeNoteScope}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch retro/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Make private' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Make public to workspace' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Make private' }));
    await waitFor(() => expect(onChangeNoteScope).toHaveBeenCalledWith(target, 'personal'));
  });

  it('leaves both note actions disabled on a workspace note owned by someone else', async () => {
    const onArchiveNote = vi.fn(async () => undefined);
    const onChangeNoteScope = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[{
              ...note('00000000-0000-4000-8000-000000000032', 'Shared research', '2026-07-31T19:45:00.000Z'),
              ownerUserId: 'user-2',
              scope: 'workspace',
            }]}
            onArchiveNote={onArchiveNote}
            onChangeNoteScope={onChangeNoteScope}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Shared research/u }), { clientX: 120, clientY: 90 });

    const item = await screen.findByRole('menuitem', { name: 'Archive note' });
    expect(item).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Make private' })).toHaveAttribute('data-disabled');
    fireEvent.click(item);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make private' }));
    expect(onArchiveNote).not.toHaveBeenCalled();
    expect(onChangeNoteScope).not.toHaveBeenCalled();
  });

  it('reports a visibility change that the server rejected', async () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[note('00000000-0000-4000-8000-000000000035', 'Customer interview', '2026-07-31T19:55:00.000Z')]}
            onChangeNoteScope={vi.fn(async () => {
              throw new Error('The note could not be reached.');
            })}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Customer interview/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make public to workspace' }));

    const dialog = await screen.findByRole('dialog', { name: 'Note visibility could not be changed' });
    expect(within(dialog).getByText('The note is still private. Try again in a moment.')).toBeVisible();
    expect(within(dialog).getByText('The note could not be reached.')).toBeVisible();
  });

  it('reports a note archive that the server rejected instead of failing silently', async () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[note('00000000-0000-4000-8000-000000000033', 'Customer interview', '2026-07-31T19:55:00.000Z')]}
            onArchiveNote={vi.fn(async () => {
              throw new Error('The note could not be reached.');
            })}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Customer interview/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive note' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Archive note' })).getByRole('button', { name: 'Archive' }));

    const dialog = await screen.findByRole('dialog', { name: 'Note could not be archived' });
    expect(within(dialog).getByText('The note could not be reached.')).toBeVisible();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Note could not be archived' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Customer interview/u })).toBeVisible();
  });

  it('copies a work-stream link and the other resource identifiers only while debugging is enabled', async () => {
    // A real work-stream id, because the row copies a canonical link and
    // `workstreamCanonicalUrl` refuses anything that is not a UUID.
    const target = workstream('00000000-0000-4000-8000-000000000042', 'Quarterly planning', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[automation]}
            notes={[note('00000000-0000-4000-8000-000000000037', 'Customer interview', '2026-07-31T19:55:00.000Z')]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const workstreamRow = screen.getByRole('link', { name: /Quarterly planning/u });
    fireEvent.contextMenu(workstreamRow, { clientX: 120, clientY: 90 });
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Copy work stream link' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    const noteRow = screen.getByRole('link', { name: /Customer interview/u });
    fireEvent.contextMenu(noteRow, { clientX: 120, clientY: 90 });
    expect(await screen.findByRole('menuitem', { name: 'Archive note' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Copy note id' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    // The Settings window owns the preference; the sidebar learns about a
    // change through the application-settings broadcast.
    announceApplicationSettings({ lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

    fireEvent.contextMenu(workstreamRow, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy work stream link' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(
      'https://rallywith.ai/app/workspaces/global/00000000-0000-7000-8000-000000000001/workstreams/00000000-0000-4000-8000-000000000042',
    ));

    fireEvent.contextMenu(noteRow, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy note id' }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('00000000-0000-4000-8000-000000000037'));
  });

  it('holds the visibility item while its own change is in flight', async () => {
    let release = (): void => undefined;
    const onChangeNoteScope = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const target = note('00000000-0000-4000-8000-000000000038', 'Customer interview', '2026-07-31T19:55:00.000Z');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[target]}
            onChangeNoteScope={onChangeNoteScope}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    // An open Radix menu hides the rest of the page from the accessibility
    // tree, so the row is held by reference rather than re-queried by role.
    const row = screen.getByRole('link', { name: /Customer interview/u });
    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make public to workspace' }));
    await waitFor(() => expect(onChangeNoteScope).toHaveBeenCalledTimes(1));

    // Reopening the menu before the first PATCH lands must not fire a second
    // one: on a public→private change each one re-runs the privacy notices.
    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    const item = await screen.findByRole('menuitem', { name: 'Make public to workspace' });
    expect(item).toHaveAttribute('data-disabled');
    fireEvent.click(item);
    expect(onChangeNoteScope).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Make public to workspace' }))
      .not.toHaveAttribute('data-disabled'));
  });

  it('archives a work stream from the menu once the confirmation is accepted', async () => {
    const onArchiveWorkstream = vi.fn(async () => undefined);
    const target = workstream('archive-me', 'Quarterly planning', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onArchiveWorkstream={onArchiveWorkstream}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const row = screen.getByRole('link', { name: /Quarterly planning/u });
    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive work stream' }));

    // Cancelling is the whole point of confirming: a right-click that landed a
    // row away from where it was aimed must not have archived anything.
    const dialog = await screen.findByRole('dialog', { name: 'Archive work stream' });
    expect(within(dialog).getByText('Quarterly planning')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive work stream' }))
      .not.toBeInTheDocument());
    expect(onArchiveWorkstream).not.toHaveBeenCalled();

    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive work stream' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Archive work stream' }))
      .getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(onArchiveWorkstream).toHaveBeenCalledWith(target));
    await waitFor(() => expect(reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'workstream_action_completed', workstreamId: target.id, action: 'archive',
      visibility: 'public', origin: 'ad_hoc', pinned: false,
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive work stream' }))
      .not.toBeInTheDocument());
  });

  it('reports a work-stream archive the server rejected instead of failing silently', async () => {
    const onArchiveWorkstream = vi.fn(async () => {
      throw new Error('The work stream could not be reached.');
    });
    const target = workstream('archive-me', 'Quarterly planning', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onArchiveWorkstream={onArchiveWorkstream}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), {
      clientX: 120, clientY: 90,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive work stream' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Archive work stream' }))
      .getByRole('button', { name: 'Archive' }));

    const failure = await screen.findByRole('dialog', { name: 'Work stream could not be archived' });
    expect(within(failure).getByText('The work stream could not be reached.')).toBeVisible();
    // The copy line, not only the message: it is the sentence that tells the
    // reader the row survived, which is the whole reason this dialog exists.
    expect(within(failure).getByText('The work stream is still in the sidebar. Try again in a moment.'))
      .toBeVisible();

    fireEvent.click(within(failure).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Work stream could not be archived' }))
      .not.toBeInTheDocument());
    // The row is still there, and saying so is the reason this dialog exists:
    // the sidebar looks identical either way, so a silent failure reads as an
    // archive the list has simply not caught up with yet.
    expect(screen.getByRole('link', { name: /Quarterly planning/u })).toBeVisible();
    expect(reportTelemetryProductIntent).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'archive' }),
    );
  });

  it('marks work streams unread on the server and renames from the menu', async () => {
    const onMarkWorkstreamUnread = vi.fn(async () => undefined);
    const onRenameWorkstream = vi.fn(async () => undefined);
    const target = workstream('rename-me', 'Quarterly planning', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onMarkWorkstreamUnread={onMarkWorkstreamUnread}
            onRenameWorkstream={onRenameWorkstream}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const row = screen.getByRole('link', { name: /Quarterly planning/u });
    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Pin' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Archive work stream' })).toHaveClass('menu-item-danger');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as unread' }));
    await waitFor(() => expect(onMarkWorkstreamUnread).toHaveBeenCalledWith(target));
    await waitFor(() => expect(reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'workstream_action_completed', workstreamId: target.id, action: 'mark_unread',
      visibility: 'public', origin: 'ad_hoc', pinned: false,
    }));

    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByRole('textbox', { name: 'Work stream name' });
    fireEvent.change(input, { target: { value: 'Launch planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(onRenameWorkstream).toHaveBeenCalledWith(target, 'Launch planning'));
    await waitFor(() => expect(reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'workstream_action_completed', workstreamId: target.id, action: 'rename',
      visibility: 'public', origin: 'ad_hoc', pinned: false,
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename work stream' })).not.toBeInTheDocument());
  });
});

describe('private work streams', () => {

  beforeEach(() => {
    window.localStorage.clear();
    markWorkstreamNavigation.mockReset();
    reportTelemetryProductIntent.mockReset();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300 });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function renderWith(
    streams: WorkstreamSummary[],
    onChangeWorkstreamScope?: (workstream: WorkstreamSummary, scope: 'personal' | 'workspace') => Promise<void>,
  ): void {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            {...(onChangeWorkstreamScope ? { onChangeWorkstreamScope } : {})}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={streams}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
  }

  it('does not wear the lock a private note does', () => {
    renderWith([{
      ...workstream('00000000-4000-4000-8000-000000000021', 'Digest · Adam', 'completed'),
      scope: 'personal',
      systemKind: 'digest',
      participantUserIds: ['user-1'],
    }]);

    const row = screen.getByRole('link', { name: /Digest/u });
    expect(screen.queryByLabelText('Private work stream')).not.toBeInTheDocument();
    expect(row.querySelector('.sidebar-workstream-facepile')).toBeNull();
  });

  it('explains a public work stream on hover', async () => {
    renderWith([workstream('00000000-4000-4000-8000-00000000002f', 'Launch', 'completed')]);

    const globe = screen.getByRole('link', { name: /Launch/u }).querySelector('.sidebar-workstream-public');
    if (!globe) throw new Error('the workspace-scoped row rendered no public marker');
    fireEvent.pointerMove(globe, { pointerType: 'mouse' });

    expect(await screen.findByRole('tooltip')).toHaveTextContent('This is a public work stream');
  });

  it('marks a workspace-scoped work stream as public', () => {
    renderWith([{
      ...workstream('00000000-4000-4000-8000-000000000022', 'Launch', 'completed'),
      // Participant presence remains visible even when the work stream is
      // available to the whole workspace.
      participantUserIds: ['user-1', 'user-2'],
      participantExtraCount: 3,
    }]);

    const row = screen.getByRole('link', { name: /Launch/u });
    expect(row.querySelector('.sidebar-workstream-public')).not.toBeNull();
    expect(screen.queryByLabelText('Private work stream')).not.toBeInTheDocument();
    expect(row.querySelector('.sidebar-workstream-facepile')).toBeNull();
  });

  it('closes a work stream to the people in it from the right-click menu', async () => {
    const onChangeWorkstreamScope = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [workstream('00000000-4000-4000-8000-000000000023', 'Launch', 'completed')],
      onChangeWorkstreamScope,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch/u }), { clientX: 120, clientY: 90 });
    // Named for the state it moves to, the way the note item is.
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make private' }));

    expect(onChangeWorkstreamScope).toHaveBeenCalledWith(
      expect.objectContaining({ id: '00000000-4000-4000-8000-000000000023' }),
      'personal',
    );
  });

  it('opens a private work stream back up to the workspace', async () => {
    const onChangeWorkstreamScope = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [{
        ...workstream('00000000-4000-4000-8000-000000000024', 'Comp review', 'completed'),
        scope: 'personal',
      }],
      onChangeWorkstreamScope,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Comp review/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make public to workspace' }));

    expect(onChangeWorkstreamScope).toHaveBeenCalledWith(
      expect.objectContaining({ id: '00000000-4000-4000-8000-000000000024' }),
      'workspace',
    );
  });

  // A system work stream takes its audience from the subsystem, so the menu
  // does not offer a change that would not happen.
  it('does not offer the toggle on a work stream that belongs to Rally itself', async () => {
    renderWith([{
      ...workstream('00000000-4000-4000-8000-000000000027', 'Digest · Adam', 'completed'),
      scope: 'personal',
      systemKind: 'digest',
    }]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Digest/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Make public to workspace' })).not.toBeInTheDocument();
  });

  it('reports a visibility change the server rejected instead of failing silently', async () => {
    renderWith(
      [workstream('00000000-4000-4000-8000-000000000028', 'Launch', 'completed')],
      vi.fn(async () => {
        throw new Error('The work stream could not be reached.');
      }),
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make private' }));

    const dialog = await screen.findByRole('dialog', { name: 'Work stream visibility could not be changed' });
    expect(within(dialog).getByText('The work stream is still visible to the workspace. Try again in a moment.'))
      .toBeVisible();
    expect(within(dialog).getByText('The work stream could not be reached.')).toBeVisible();
  });
});

describe('pinned work streams', () => {
  // jsdom implements no layout and therefore no `scrollIntoView`; the sidebar
  // calls it optionally for that reason, so a test that wants to observe the
  // call has to put one there.
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    markWorkstreamNavigation.mockReset();
    reportTelemetryProductIntent.mockReset();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300 });
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Deleting rather than restoring: jsdom never defined it in the first
    // place, so leaving the stub behind would hide this same gap from any test
    // that runs after these.
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  function renderWith(
    streams: WorkstreamSummary[],
    actions: Partial<{
      onPinWorkstream: (workstream: WorkstreamSummary, pinned: boolean) => Promise<boolean>;
      onReorderPinnedWorkstreams: (workstreamIds: string[]) => Promise<void>;
    }> = {},
  ): void {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            {...actions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={streams}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
  }

  /** The pinned section's rows, in the order they are rendered. */
  function pinnedRowTitles(): string[] {
    const section = screen.getByRole('region', { name: 'Pinned' });
    return within(section).getAllByRole('link').map((row) => row.textContent ?? '');
  }

  /** The `sidebar-context-target` wrapper that carries a row's drag handlers. */
  function dragTarget(name: RegExp): HTMLElement {
    const wrapper = screen.getByRole('link', { name }).parentElement;
    if (!wrapper) throw new Error('The work-stream row has no drag wrapper');
    return wrapper;
  }

  /**
   * jsdom implements no `DataTransfer`. `dropEffect` is the field that matters:
   * a drag the pinned list accepted reports `move` back on `dragend`, and one
   * cancelled with Escape or released off the list reports `none`.
   */
  function dataTransfer(dropEffect: 'move' | 'none' = 'move'): {
    dropEffect: string;
    effectAllowed: string;
    setData: () => void;
  } {
    return { dropEffect, effectAllowed: '', setData: () => undefined };
  }

  it('lifts a pinned work stream out of the recent list into its own section', () => {
    renderWith([
      pinned(workstream('ws-pinned', 'Launch tracking', 'completed'), 0),
      workstream('ws-recent', 'Quarterly planning', 'completed'),
    ]);

    const section = screen.getByRole('region', { name: 'Pinned' });
    expect(within(section).getByRole('link', { name: /Launch tracking/u })).toBeVisible();
    // Once, not twice: the recent list keeps only what is not pinned.
    expect(screen.getAllByRole('link', { name: /Launch tracking/u })).toHaveLength(1);
    expect(within(section).queryByRole('link', { name: /Quarterly planning/u })).not.toBeInTheDocument();
  });

  it('shows no Pinned section until something is pinned', () => {
    renderWith([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    expect(screen.queryByRole('region', { name: 'Pinned' })).not.toBeInTheDocument();
  });

  it('renders pinned rows in their stored order rather than by activity', () => {
    renderWith([
      pinned(workstream('ws-a', 'Alpha', 'completed', '2026-07-31T20:00:00.000Z'), 1),
      pinned(workstream('ws-b', 'Bravo', 'completed', '2026-07-20T20:00:00.000Z'), 0),
    ]);

    expect(pinnedRowTitles()).toEqual([expect.stringContaining('Bravo'), expect.stringContaining('Alpha')]);
  });

  it('does not navigate behind an open modal dialog', async () => {
    renderWith([
      pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
      pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
    ]);

    const bravo = screen.getByRole('link', { name: /Bravo/u });
    fireEvent.contextMenu(screen.getByRole('link', { name: /Alpha/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    expect(screen.getByRole('dialog', { name: 'Rename work stream' })).toBeVisible();

    fireEvent.keyDown(window, { code: 'Digit2', key: '2', metaKey: true });

    expect(bravo).not.toHaveClass('is-active');
  });

  it('offers Pin on a recent row and Unpin on a pinned one', async () => {
    const onPinWorkstream = vi.fn(async (): Promise<boolean> => true);
    renderWith(
      [
        pinned(workstream('ws-pinned', 'Launch tracking', 'completed'), 0),
        workstream('ws-recent', 'Quarterly planning', 'completed'),
      ],
      { onPinWorkstream },
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(onPinWorkstream)
      .toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-recent' }), true));

    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch tracking/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
    await waitFor(() => expect(onPinWorkstream)
      .toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-pinned' }), false));
  });

  it('reorders under the pointer during a drag and sends the whole arrangement on drop', async () => {
    const onReorderPinnedWorkstreams = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
        pinned(workstream('ws-c', 'Charlie', 'completed'), 2),
      ],
      { onReorderPinnedWorkstreams },
    );

    fireEvent.dragStart(dragTarget(/Charlie/u), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(dragTarget(/Alpha/u), { dataTransfer: dataTransfer() });

    // The list settles before anything is sent, so the drop lands where the
    // pointer is rather than where the server last agreed it was.
    expect(pinnedRowTitles()).toEqual([
      expect.stringContaining('Charlie'),
      expect.stringContaining('Alpha'),
      expect.stringContaining('Bravo'),
    ]);

    fireEvent.dragEnd(dragTarget(/Charlie/u), { dataTransfer: dataTransfer('move') });
    await waitFor(() => expect(onReorderPinnedWorkstreams).toHaveBeenCalledWith(['ws-c', 'ws-a', 'ws-b']));
  });

  it('sends nothing when a drag ends where it started', () => {
    const onReorderPinnedWorkstreams = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
      ],
      { onReorderPinnedWorkstreams },
    );

    fireEvent.dragStart(dragTarget(/Alpha/u), { dataTransfer: dataTransfer() });
    fireEvent.dragEnd(dragTarget(/Alpha/u), { dataTransfer: dataTransfer('move') });

    expect(onReorderPinnedWorkstreams).not.toHaveBeenCalled();
  });

  // Backing out of a drag has to mean backing out of it. The rows have already
  // moved under the pointer by then, so treating the release the same way a
  // drop is treated would make Escape the slowest possible way to reorder.
  it('abandons the arrangement when a drag is cancelled rather than dropped', async () => {
    const onReorderPinnedWorkstreams = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
      ],
      { onReorderPinnedWorkstreams },
    );

    fireEvent.dragStart(dragTarget(/Bravo/u), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(dragTarget(/Alpha/u), { dataTransfer: dataTransfer() });
    expect(pinnedRowTitles()).toEqual([expect.stringContaining('Bravo'), expect.stringContaining('Alpha')]);

    // Escape, or a release anywhere nothing accepted the drop.
    fireEvent.dragEnd(dragTarget(/Bravo/u), { dataTransfer: dataTransfer('none') });

    expect(onReorderPinnedWorkstreams).not.toHaveBeenCalled();
    await waitFor(() => expect(pinnedRowTitles())
      .toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Bravo')]));
  });

  it('moves a pinned row with the keyboard, so the order is not pointer-only', async () => {
    const onReorderPinnedWorkstreams = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
      ],
      { onReorderPinnedWorkstreams },
    );

    // Fired on the row itself, which is what holds focus: the handler sits on
    // the wrapper around it and only ever sees the event by bubbling.
    fireEvent.keyDown(screen.getByRole('link', { name: /Bravo/u }), { key: 'ArrowUp', altKey: true });
    await waitFor(
      () => expect(onReorderPinnedWorkstreams).toHaveBeenCalledWith(['ws-b', 'ws-a']),
    );

    // Observing the async save is not the same as observing its `finally`.
    // This harness deliberately leaves the server-owned props unchanged, so
    // wait until the optimistic order has cleared before testing the stored
    // order's top boundary. Otherwise the second keydown races cleanup and can
    // turn the still-optimistic ['ws-b', 'ws-a'] back into ['ws-a', 'ws-b'].
    await waitFor(
      () => expect(pinnedRowTitles()).toEqual([
        expect.stringContaining('Alpha'),
        expect.stringContaining('Bravo'),
      ]),
    );

    // The top row has nowhere further to go, and saying so costs a request.
    onReorderPinnedWorkstreams.mockClear();
    fireEvent.keyDown(screen.getByRole('link', { name: /Alpha/u }), { key: 'ArrowUp', altKey: true });
    expect(onReorderPinnedWorkstreams).not.toHaveBeenCalled();
  });

  // Two moves in a row overlap, because the first request is still in flight
  // when the second is made. Whichever lands first must not put the list back
  // to an order the reader has already moved past.
  it('holds the newer arrangement when an older reorder finishes underneath it', async () => {
    const settle: (() => void)[] = [];
    const onReorderPinnedWorkstreams = vi.fn(
      () => new Promise<void>((resolve) => settle.push(resolve)),
    );
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
        pinned(workstream('ws-c', 'Charlie', 'completed'), 2),
      ],
      { onReorderPinnedWorkstreams },
    );

    fireEvent.keyDown(screen.getByRole('link', { name: /Charlie/u }), { key: 'ArrowUp', altKey: true });
    fireEvent.keyDown(screen.getByRole('link', { name: /Charlie/u }), { key: 'ArrowUp', altKey: true });
    expect(onReorderPinnedWorkstreams).toHaveBeenNthCalledWith(1, ['ws-a', 'ws-c', 'ws-b']);
    expect(onReorderPinnedWorkstreams).toHaveBeenNthCalledWith(2, ['ws-c', 'ws-a', 'ws-b']);

    await act(async () => {
      settle[0]?.();
    });

    // Not [Alpha, Bravo, Charlie], which is what the unchanged props still say.
    expect(pinnedRowTitles()).toEqual([
      expect.stringContaining('Charlie'),
      expect.stringContaining('Alpha'),
      expect.stringContaining('Bravo'),
    ]);

    await act(async () => {
      settle[1]?.();
    });
  });

  // A release over the heading is a release inside the list the reader is
  // arranging. Leaving it uncovered would read as a cancellation and throw the
  // arrangement away a few pixels above the first row.
  it('accepts a drop anywhere in the section, heading included', () => {
    const onReorderPinnedWorkstreams = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
      ],
      { onReorderPinnedWorkstreams },
    );

    const heading = screen.getByRole('heading', { name: 'Pinned' });
    const transfer = dataTransfer('none');
    fireEvent.dragOver(heading, { dataTransfer: transfer });

    // The section handled it, so a release here reports a move rather than the
    // `none` that `dragend` reads as a drag backed out of.
    expect(transfer.dropEffect).toBe('move');
  });

  it('says how to reorder once for the section, not on every row', () => {
    renderWith([
      pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
      pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
    ]);

    // The instruction is one element the section points at. On the rows it
    // would land inside each link's accessible name and be read out again
    // before every title.
    expect(screen.getAllByText(/Hold Alt and press the up or down arrow/u)).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Pinned' }))
      .toHaveAccessibleDescription(/Hold Alt and press the up or down arrow/u);
    expect(screen.getByRole('link', { name: /Alpha/u })).toHaveAccessibleName(/Pinned, 1 of 2\.$/u);
  });

  /**
   * The sidebar the way the shell drives it: pinning updates the list this
   * component is given, a tick after the action resolves.
   *
   * A mock that resolves without moving the row would let the reveal appear to
   * work while scrolling to where the row used to be — which is precisely the
   * bug this harness exists to catch, so the delay is deliberate rather than
   * incidental.
   */
  function renderPinnable(streams: WorkstreamSummary[]): { pins: string[] } {
    const pins: string[] = [];
    function Harness(): React.JSX.Element {
      const [workstreams, setWorkstreams] = useState(streams);
      return (
        <Sidebar
          {...defaultActions}
          automations={[]}
          onPinWorkstream={async (workstream, pinned) => {
            pins.push(`${pinned ? 'pin' : 'unpin'}:${workstream.id}`);
            await Promise.resolve();
            setWorkstreams((current) => current.map((item) => item.id === workstream.id
              ? { ...item, pinPosition: pinned ? 0 : null }
              : item));
            return true;
          }}
          onSignOut={vi.fn()}
          workspace={workspace}
          workstreams={workstreams}
        />
      );
    }
    render(<MemoryRouter><Tooltip.Provider><Harness /></Tooltip.Provider></MemoryRouter>);
    return { pins };
  }

  // Pinning moves the row to a section the reader is very likely scrolled away
  // from — they pinned it because they were tired of hunting for it down the
  // list — so without this the action reads as the row vanishing.
  it('brings a work stream back into view once the list carries the pin', async () => {
    renderPinnable([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    // The row scrolled to is the one in the Pinned section, not the one the
    // recent list was still showing when the request came back.
    const scrolled = scrollIntoView.mock.instances[0] as Element;
    expect(scrolled).toHaveAttribute('data-workstream-id', 'ws-recent');
    expect(screen.getByRole('region', { name: 'Pinned' })).toContainElement(scrolled as HTMLElement);
    expect(reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'workstream_action_completed', workstreamId: 'ws-recent', action: 'pin',
      visibility: 'public', origin: 'ad_hoc', pinned: true,
    });
    // `nearest` is what keeps a row already on screen from being yanked around.
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));
  });

  // Motion is what lets the reader follow the row, so it is the default — but
  // it is exactly the kind of movement somebody turns off, and asserting only
  // on `block` would let that preference be ignored silently.
  it.each([
    { reduced: false, behavior: 'smooth' },
    { reduced: true, behavior: 'auto' },
  ])('scrolls with $behavior when reduced motion is $reduced', async ({ reduced, behavior }) => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
    }));
    renderPinnable([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior })));
  });

  // jsdom does not define `matchMedia` at all, and neither does an Electron
  // window in some startup states, so the sidebar has to reach it optionally.
  it('still scrolls where the preference cannot be read', async () => {
    renderPinnable([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' })));
  });

  // The two sections are separate subtrees, so the row is unmounted and
  // remounted as it moves and Radix has nothing left to restore focus to. For
  // somebody driving the sidebar from the keyboard, "where I was" is focus, not
  // scrollTop, and the next Tab otherwise restarts at the top of the window.
  it('takes focus with the row, since scrollTop is only half of following it', async () => {
    renderPinnable([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));

    const moved = await screen.findByRole('region', { name: 'Pinned' });
    await waitFor(() => expect(document.activeElement)
      .toBe(within(moved).getByRole('link', { name: /Quarterly planning/u })));
  });

  it('leaves focus alone when it is somewhere real', async () => {
    renderPinnable([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    // Whoever put focus here owns it, and a pin is not a reason to take it.
    const elsewhere = screen.getByRole('button', { name: 'Open navigation' });
    elsewhere.focus();

    await screen.findByRole('region', { name: 'Pinned' });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(document.activeElement).toBe(elsewhere);
  });

  it('brings it back into view after unpinning too, since that moves it as far', async () => {
    renderPinnable([pinned(workstream('ws-pinned', 'Launch tracking', 'completed'), 0)]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch tracking/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    const scrolled = scrollIntoView.mock.instances[0] as Element;
    expect(scrolled).toHaveAttribute('data-workstream-id', 'ws-pinned');
    expect(screen.queryByRole('region', { name: 'Pinned' })).not.toBeInTheDocument();
  });

  // The shell discards a pin response a later one has superseded, so the action
  // behind it has no row movement to follow — and dragging the viewport back to
  // the row the reader has already finished with is worse than doing nothing.
  it('scrolls nothing when a later pin superseded this one', async () => {
    // The list still ends up showing the row pinned, because the newer
    // request's response carried it. Without that the reveal would simply never
    // match and the test would pass whatever the code did.
    function Superseded(): React.JSX.Element {
      const [streams, setStreams] = useState([workstream('ws-recent', 'Quarterly planning', 'completed')]);
      return (
        <Sidebar
          {...defaultActions}
          automations={[]}
          onPinWorkstream={async () => {
            await Promise.resolve();
            setStreams((current) => current.map((item) => ({ ...item, pinPosition: 0 })));
            return false;
          }}
          onSignOut={vi.fn()}
          workspace={workspace}
          workstreams={streams}
        />
      );
    }
    render(<MemoryRouter><Tooltip.Provider><Superseded /></Tooltip.Provider></MemoryRouter>);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));

    await screen.findByRole('region', { name: 'Pinned' });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  // Arming the reveal for a row the list does not carry would leave it waiting
  // indefinitely, ready to seize the viewport whenever that work stream
  // reappeared — seconds later, on an unrelated poll.
  it('does not stay armed for a row that leaves the list', async () => {
    const row = workstream('ws-gone', 'Quarterly planning', 'completed');
    function Vanishing(): React.JSX.Element {
      const [streams, setStreams] = useState([row]);
      return (
        <>
          <button onClick={() => setStreams([{ ...row, pinPosition: 0 }])} type="button">Bring it back</button>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onPinWorkstream={async () => {
              await Promise.resolve();
              setStreams([]);
              return true;
            }}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={streams}
          />
        </>
      );
    }
    render(<MemoryRouter><Tooltip.Provider><Vanishing /></Tooltip.Provider></MemoryRouter>);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /Quarterly planning/u })).not.toBeInTheDocument());

    // The row reappearing later — a poll, an unarchive — is not a reason to
    // scroll to it. The pin that would have asked for that is long finished.
    fireEvent.click(screen.getByRole('button', { name: 'Bring it back' }));
    await screen.findByRole('region', { name: 'Pinned' });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  // A reveal the list never honours would otherwise be re-evaluated on every
  // fifteen-second poll and fire whenever the state happened to match, moving
  // the sidebar under somebody who pinned something a minute ago.
  it('gives up on a reveal the list never honours', async () => {
    const row = workstream('ws-slow', 'Quarterly planning', 'completed');
    function Slow(): React.JSX.Element {
      const [streams, setStreams] = useState([row]);
      return (
        <>
          <button onClick={() => setStreams([{ ...row, pinPosition: 0 }])} type="button">Let it land</button>
          <Sidebar
            {...defaultActions}
            automations={[]}
            // Reports applied, but the list does not follow — the shape of a
            // response overtaken by a change from another device.
            onPinWorkstream={async () => true}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={streams}
          />
        </>
      );
    }
    render(<MemoryRouter><Tooltip.Provider><Slow /></Tooltip.Provider></MemoryRouter>);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Pin' })).not.toBeInTheDocument());

    // Real time rather than fake: this asserts on a `setTimeout` the component
    // owns, and driving the clock out from under React's effects here made the
    // deadline appear to fire without the state having settled.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, REVEAL_DEADLINE_MS + 200));
    });

    // The state arriving late is not a reason to scroll: the action that asked
    // for it is long finished.
    fireEvent.click(screen.getByRole('button', { name: 'Let it land' }));
    await screen.findByRole('region', { name: 'Pinned' });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls nothing when the pin was refused', async () => {
    renderWith(
      [workstream('ws-recent', 'Quarterly planning', 'completed')],
      {
        onPinWorkstream: vi.fn(async () => {
          throw new Error('The work stream could not be reached.');
        }),
      },
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));

    // The row never moved, so following it somewhere would be following it
    // nowhere — on top of the dialog already explaining what happened.
    await screen.findByRole('dialog', { name: 'Work stream could not be pinned' });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not scroll again on a later render', async () => {
    renderPinnable([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

    // The list re-renders on every poll. Scrolling the reader on each one
    // would make the sidebar unusable while they read something else.
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize navigation' }), { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('separator', { name: 'Resize navigation' }))
      .toHaveAttribute('aria-valuenow', '316'));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('leaves a recent row undraggable, since its order is activity and not a choice', () => {
    renderWith([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    expect(dragTarget(/Quarterly planning/u)).not.toHaveAttribute('draggable', 'true');
  });

  it('reports a rejected reorder and falls back to the order the server holds', async () => {
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
      ],
      {
        onReorderPinnedWorkstreams: vi.fn(async () => {
          throw new Error('The pinned list could not be reached.');
        }),
      },
    );

    // Fired on the row itself, which is what holds focus: the handler sits on
    // the wrapper around it and only ever sees the event by bubbling.
    fireEvent.keyDown(screen.getByRole('link', { name: /Bravo/u }), { key: 'ArrowUp', altKey: true });

    const dialog = await screen.findByRole('dialog', { name: 'Pinned work streams could not be reordered' });
    expect(within(dialog).getByText('The pinned list is back in the order it was in. Try again in a moment.'))
      .toBeVisible();
    // The open dialog hides the sidebar from the accessibility tree, so the
    // order can only be read once it is dismissed.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(pinnedRowTitles()).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Bravo')]);
  });

  it('reports a pin the server refused', async () => {
    renderWith(
      [workstream('ws-recent', 'Quarterly planning', 'completed')],
      {
        onPinWorkstream: vi.fn(async () => {
          throw new Error('The work stream could not be reached.');
        }),
      },
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));

    const dialog = await screen.findByRole('dialog', { name: 'Work stream could not be pinned' });
    expect(within(dialog).getByText('The work stream could not be reached.')).toBeVisible();
  });
});

describe('Sidebar work-stream paging', () => {
  beforeEach(() => {
    window.localStorage.clear();
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true };
    applicationSettings.listeners.clear();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300 });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function renderWithPaging(overrides: {
    hasMoreWorkstreams?: boolean;
    hasMoreNotes?: boolean;
    loadingMoreWorkstreams?: boolean;
    loadingMoreNotes?: boolean;
    onLoadMoreWorkstreams?: () => void;
    onLoadMoreNotes?: () => void;
  }): HTMLElement {
    const { container } = render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[workstream('one', 'Launch brief', 'completed')]}
            {...overrides}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
    // The scroll container is an unnamed `nav` landmark inside the labelled
    // `aside`, so there is no accessible name to query it by.
    return container.querySelector('.sidebar-scroll') as HTMLElement;
  }

  /** jsdom lays nothing out, so the scroll geometry is declared outright. */
  function scrollTo(nav: HTMLElement, scrollTop: number): void {
    Object.defineProperty(nav, 'scrollHeight', { configurable: true, value: 2_000 });
    Object.defineProperty(nav, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(nav, 'scrollTop', { configurable: true, value: scrollTop });
    fireEvent.scroll(nav);
  }

  it('asks for the next page as the scroll approaches the end', () => {
    const onLoadMoreWorkstreams = vi.fn();
    const nav = renderWithPaging({ hasMoreWorkstreams: true, onLoadMoreWorkstreams });

    // 1000px of list still below the fold: too early to spend a request.
    scrollTo(nav, 200);
    expect(onLoadMoreWorkstreams).not.toHaveBeenCalled();

    // Within the threshold, and ahead of the end rather than at it, so the rows
    // are usually there by the time the reader arrives.
    scrollTo(nav, 900);
    expect(onLoadMoreWorkstreams).toHaveBeenCalledTimes(1);
  });

  it('opens workspace search without loading sidebar pages', () => {
    const onOpenSearch = vi.fn();
    const onLoadMoreWorkstreams = vi.fn();
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[]}
      onSignOut={vi.fn()} workspace={workspace} workstreams={[]} hasMoreWorkstreams
      onOpenSearch={onOpenSearch} onLoadMoreWorkstreams={onLoadMoreWorkstreams} /></Tooltip.Provider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Search workspace' }));
    expect(onOpenSearch).toHaveBeenCalledOnce();
    expect(onLoadMoreWorkstreams).not.toHaveBeenCalled();
  });

  it('asks both lists for their next page, since one set of headings holds both', () => {
    // Notes and work streams interleave by recency under the same headings, so
    // the row at the bottom belongs to one of them and the *other* is what the
    // next heading down needs. Asking only for the kind at the end would stall
    // the list wherever one of the two runs out — and for notes that used to be
    // permanent, because the list did not page at all.
    const onLoadMoreWorkstreams = vi.fn();
    const onLoadMoreNotes = vi.fn();
    const nav = renderWithPaging({
      hasMoreWorkstreams: true,
      hasMoreNotes: true,
      onLoadMoreWorkstreams,
      onLoadMoreNotes,
    });

    scrollTo(nav, 900);

    expect(onLoadMoreWorkstreams).toHaveBeenCalledTimes(1);
    expect(onLoadMoreNotes).toHaveBeenCalledTimes(1);
  });

  it('asks only the list that still has pages', () => {
    const onLoadMoreWorkstreams = vi.fn();
    const onLoadMoreNotes = vi.fn();
    const nav = renderWithPaging({
      hasMoreWorkstreams: false,
      hasMoreNotes: true,
      onLoadMoreWorkstreams,
      onLoadMoreNotes,
    });

    scrollTo(nav, 900);

    expect(onLoadMoreWorkstreams).not.toHaveBeenCalled();
    expect(onLoadMoreNotes).toHaveBeenCalledTimes(1);
  });

  it('asks notes once while their page is in flight', () => {
    const onLoadMoreNotes = vi.fn();
    const nav = renderWithPaging({
      hasMoreNotes: true,
      loadingMoreNotes: true,
      onLoadMoreNotes,
    });

    scrollTo(nav, 1_100);

    expect(onLoadMoreNotes).not.toHaveBeenCalled();
  });

  it('asks once while a page is in flight', () => {
    const onLoadMoreWorkstreams = vi.fn();
    // A flick fires a scroll event per frame, and the list is one cache entry
    // that a second response would append to twice.
    const nav = renderWithPaging({
      hasMoreWorkstreams: true,
      loadingMoreWorkstreams: true,
      onLoadMoreWorkstreams,
    });

    scrollTo(nav, 1_100);
    scrollTo(nav, 1_150);

    expect(onLoadMoreWorkstreams).not.toHaveBeenCalled();
    expect(screen.getByText('Loading more…')).toBeInTheDocument();
  });

  it('does not ask at the end of the list', () => {
    const onLoadMoreWorkstreams = vi.fn();
    const nav = renderWithPaging({ hasMoreWorkstreams: false, onLoadMoreWorkstreams });

    scrollTo(nav, 1_200);

    expect(onLoadMoreWorkstreams).not.toHaveBeenCalled();
    // No standing invitation to scroll: a list that ends on a page boundary
    // would otherwise claim forever that there is more.
    expect(screen.queryByText('Loading more…')).not.toBeInTheDocument();
  });
});
