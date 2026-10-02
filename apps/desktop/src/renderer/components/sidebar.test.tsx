import * as Tooltip from '@radix-ui/react-tooltip';
import { SpaceSummarySchema, WORKSTREAM_NAMING_GRACE_MS } from '@rally/contracts';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../lib/format';
import { ApiError } from '../lib/api';
import {
  consumeDeepLinkWorkstreamNavigation,
  markDeepLinkWorkstreamNavigation,
} from '../lib/deep-link-navigation';
import type { Workspace, WorkstreamSummary } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { installWindowActivationTracking } from '../lib/window-activation';
import { allPinPosition, channelPinTargets, REVEAL_DEADLINE_MS, Sidebar } from './sidebar';

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
const updateStatus = vi.hoisted(() => ({ current: { kind: 'idle' } as { kind: string; version?: string } }));
const installDownloadedUpdate = vi.hoisted(() => vi.fn(async () => undefined));
const applicationSettings = vi.hoisted(() => ({
  current: { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true },
  listeners: new Set<(settings: unknown) => void>(),
}));

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
    getUpdateStatus: () => Promise.resolve(updateStatus.current),
    installDownloadedUpdate,
    onUpdateStatusChanged: () => () => undefined,
  }),
  desktopServicesAvailable: () => false,
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
const TEST_SPACE_ID = '00000000-0000-7000-8000-0000000000f2';

const defaultActions = {
  onArchiveWorkstream: async (): Promise<void> => undefined,
  onApplyWorkstreamBatch: async (): Promise<{ enqueuedCount: number; archivedNoteCount: number }> =>
    ({ enqueuedCount: 0, archivedNoteCount: 0 }),
  onChangeWorkstreamScope: async (): Promise<void> => undefined,
  onMarkWorkstreamUnread: async (): Promise<void> => undefined,
  onPreviewWorkstreamBatch: async (): Promise<{ matchedCount: number; matchedNoteCount: number }> =>
    ({ matchedCount: 0, matchedNoteCount: 0 }),
  onPinWorkstream: async (): Promise<boolean> => true,
  onReorderPinnedWorkstreams: async (): Promise<void> => undefined,
  onRenameWorkstream: async (): Promise<void> => undefined,
  onRunAutomation: async (): Promise<void> => undefined,
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
    spaceIds: [],
    lastActivityAt,
    ...viewerState,
  };
}

/** The same work stream, pinned by the viewer at `position`. */
function pinned(workstream: WorkstreamSummary, position: number): WorkstreamSummary {
  return {
    ...workstream,
    pinPosition: position,
    spaceIds: [TEST_SPACE_ID],
    spacePins: [{ spaceId: TEST_SPACE_ID, position }],
  };
}

function space(
  id = '00000000-0000-7000-8000-0000000000f2',
  name = 'Hiring',
  overrides: Record<string, unknown> = {},
) {
  return SpaceSummarySchema.parse({
    id,
    name,
    iconKey: 'briefcase',
    colorKey: 'blue',
    scope: 'personal',
    status: 'active',
    systemRole: null,
    revision: 1,
    reach: 'participant',
    participants: [{ userId: '00000000-0000-7000-8000-0000000000f1' }],
    channelCount: 0,
    defaultResourceIds: [],
    defaultSidekickIds: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  });
}

/** General: the Organization's protected fallback, present in every sidebar. */
function general() {
  return space('00000000-0000-7000-8000-0000000000f0', 'General', {
    scope: 'workspace',
    systemRole: 'general',
  });
}

/** The same Channel, placed in each of the Spaces named. */
function placedIn(target: WorkstreamSummary, ...spaceIds: string[]): WorkstreamSummary {
  return { ...target, spaceIds };
}

/** One Space filter in the strip at the top of the sidebar. */
function pill(name: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Spaces' })).getByRole('button', { name });
}

/** The status a Channel row's dot names, or null when the row has none. */
function markerOf(title: string): string | null {
  const link = screen.getByRole('link', { name: new RegExp(`^${title}`, 'u') });
  return link.querySelector('.channel-row-marker')?.textContent ?? null;
}

/** The pills in the strip, in the order they are drawn. */
function pillNames(): string[] {
  return within(screen.getByRole('group', { name: 'Spaces' })).getAllByRole('button')
    .map((item) => item.textContent ?? '');
}

/**
 * A drag payload that keeps what the source writes, as the browser's does, so
 * a drop reads back the types the dragged row actually set.
 */
function recordingDataTransfer() {
  const data = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    get types(): string[] { return [...data.keys()]; },
    getData: (type: string): string => data.get(type) ?? '',
    setData: (type: string, value: string): void => { data.set(type, value); },
  };
}

/** Filter the Channel list to one Space, as a click on its pill does. */
function selectSpace(name: string): void {
  fireEvent.click(pill(name));
}

describe('Sidebar channel markers', () => {
  beforeEach(() => {
    const reset = markDeepLinkWorkstreamNavigation('__test_reset__');
    consumeDeepLinkWorkstreamNavigation(reset.revision);
    window.localStorage.clear();
    copyText.mockReset().mockResolvedValue(undefined);
    markSurfaceEntrypoint.mockReset();
    markWorkstreamNavigation.mockReset();
    markWorkstreamFeedOpenStarted.mockReset();
    reportTelemetryProductIntent.mockReset();
    startWorkstreamSocketWarmup.mockReset();
    cancelWorkstreamSocketWarmup.mockReset();
    workstreamSocketOpenContext.mockReset().mockReturnValue({ state: 'cold' });
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true };
    applicationSettings.listeners.clear();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300, sidebarSpaceFilter: null });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  it('orders visits ahead of shared activity and keeps unvisited rows at creation time', () => {
    const visited = { ...workstream('visited', 'Last visited', 'completed', '2026-07-01T00:00:00.000Z'),
      createdAt: '2026-07-01T00:00:00.000Z', lastAccessedAt: '2026-08-02T00:00:00.000Z' };
    const noisy = { ...workstream('noisy', 'New shared activity', 'completed', '2099-01-01T00:00:00.000Z'),
      createdAt: '2026-07-20T00:00:00.000Z', lastAccessedAt: null };
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace}
      workstreams={[noisy, visited]} /></Tooltip.Provider></MemoryRouter>);
    const links = screen.getAllByRole('link').map((link) => link.textContent);
    expect(links.findIndex((text) => text?.includes('Last visited')))
      .toBeLessThan(links.findIndex((text) => text?.includes('New shared activity')));
  });

  it('keeps the unsent new channel out of the sidebar', () => {
    render(<MemoryRouter initialEntries={['/workstreams/new']}><Tooltip.Provider>
      <Sidebar {...defaultActions} onSignOut={vi.fn()}
        spaces={[general()]} workspace={workspace} workstreams={[]} />
    </Tooltip.Provider></MemoryRouter>);

    expect(screen.queryByLabelText('New channel draft')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /New channel/u })).not.toBeInTheDocument();
  });

  it('marks sidebar creation telemetry only when the Channel setup is submitted', async () => {
    const onCreateChannel = vi.fn(async () => undefined);
    render(<MemoryRouter><Tooltip.Provider>
      <Sidebar {...defaultActions} onCreateChannel={onCreateChannel}
        onSignOut={vi.fn()} spaces={[general()]} workspace={workspace} workstreams={[]} />
    </Tooltip.Provider></MemoryRouter>);
    // The header's New channel opens the form directly, with no menu between.
    const launcher = screen.getByRole('button', { name: 'New channel' });
    expect(launcher).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(launcher);
    expect(markSurfaceEntrypoint).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Start a new channel' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Launch' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreateChannel).toHaveBeenCalledWith({ name: 'Launch', spaceId: general().id }));
    expect(markSurfaceEntrypoint).toHaveBeenCalledWith('sidebar_new');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('resizes from the keyboard and exposes its constrained width', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
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

  // Same as the work-stream divider: the press must not open what the hover
  // delay has not yet opened. A hint riding beside the edge for the length of
  // the drag covers the transcript the drag is revealing.
  it('never collapses: the edge stops at the minimum width and offers no toggle', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
    const resizer = screen.getByRole('separator', { name: 'Resize navigation' });
    resizer.setPointerCapture = vi.fn();
    vi.spyOn(screen.getByRole('complementary', { name: 'Rally navigation' }), 'getBoundingClientRect')
      .mockReturnValue({ bottom: 900, height: 900, left: 0, right: 300, toJSON: () => ({}), top: 0, width: 300, x: 0, y: 0 });

    fireEvent.focus(resizer);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Drag to resize');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Double-click');
    fireEvent.blur(resizer);

    fireEvent.doubleClick(resizer);
    fireEvent.keyDown(resizer, { key: 'Enter' });
    expect(resizer).toHaveAttribute('aria-valuenow', '300');
    expect(resizer).toHaveAttribute('aria-valuemin', '240');

    fireEvent.pointerDown(resizer, { button: 0, clientX: 300, pointerId: 5 });
    fireEvent.pointerMove(window, { clientX: 60, pointerId: 5 });
    fireEvent.pointerUp(window, { pointerId: 5 });
    expect(resizer).toHaveAttribute('aria-valuenow', '240');

    for (let step = 0; step < 4; step += 1) fireEvent.keyDown(resizer, { key: 'ArrowLeft' });
    expect(resizer).toHaveAttribute('aria-valuenow', '240');
    expect(screen.queryByRole('button', { name: /Expand|Collapse/u })).not.toBeInTheDocument();
  });

  it('keeps the hint shut through a grab that never waited for it', () => {
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    const edge = screen.getByRole('separator', { name: 'Resize navigation' });
    edge.setPointerCapture = vi.fn();
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.pointerDown(edge, { button: 0, clientX: 300, pointerId: 9 });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.pointerMove(window, { clientX: 340, pointerId: 9 });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.pointerUp(window, { pointerId: 9 });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  // Held arrow keys are the keyboard's drag: the same width written over and
  // over. Animating each step leaves the edge behind the width being written.
  // The suppression lasts exactly as long as the key.
  it('suppresses the width animation while an arrow key is held', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
    const resizer = screen.getByRole('separator', { name: 'Resize navigation' });
    const navigation = screen.getByRole('complementary', { name: 'Rally navigation' });
    expect(navigation).not.toHaveClass('is-resizing');

    fireEvent.keyDown(resizer, { key: 'ArrowLeft' });
    expect(navigation).toHaveClass('is-resizing');
    fireEvent.keyDown(resizer, { key: 'ArrowLeft' });
    expect(navigation).toHaveClass('is-resizing');

    fireEvent.keyUp(resizer, { key: 'ArrowLeft' });
    expect(navigation).not.toHaveClass('is-resizing');

    // A key that does not resize leaves the width alone, so it must not claim
    // the gesture either.
    fireEvent.keyDown(resizer, { key: 'Tab' });
    expect(navigation).not.toHaveClass('is-resizing');
  });

  it('connects a row\'s hover description to its link', async () => {
    const item = workstream('compact-preview', 'Named destination', 'completed');
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[item]} /></Tooltip.Provider></MemoryRouter>);
    const link = screen.getByRole('link', { name: item.title });
    fireEvent.pointerEnter(link.closest('[data-workstream-id]')!);
    await waitFor(() => expect(link).toHaveAttribute('aria-describedby', `workstream-preview-${item.id}`));
    expect(document.getElementById(link.getAttribute('aria-describedby')!)).toHaveTextContent(item.title);
  });

  it('forwards a channel row hover to the pooled socket warm-up', () => {
    const hovered = workstream('hovered-workstream', 'Warm this channel', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[hovered]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
    const row = screen.getByText('Warm this channel').closest('[data-workstream-id]');
    if (!row) throw new Error('The channel row has no hover target.');

    fireEvent.pointerEnter(row);
    expect(startWorkstreamSocketWarmup).toHaveBeenCalledWith(hovered.id);
    fireEvent.pointerLeave(row);
    expect(cancelWorkstreamSocketWarmup).toHaveBeenCalledWith(hovered.id);
    cancelWorkstreamSocketWarmup.mockClear();
    fireEvent.pointerCancel(row);
    expect(cancelWorkstreamSocketWarmup).toHaveBeenCalledWith(hovered.id);

    const socketLeaseId = '018f22f2-4c22-7abc-8def-012345678905';
    workstreamSocketOpenContext.mockReturnValue({ state: 'control_warmup', socketLeaseId });
    fireEvent.click(screen.getByRole('link', { name: /Warm this channel/u }));
    expect(markWorkstreamFeedOpenStarted).toHaveBeenCalledWith(
      hovered.id,
      'recent',
      'control_warmup',
      expect.any(Number),
      socketLeaseId,
    );
  });

  it('shows the last activity time on every row and no participant stacks or Command hints', () => {
    const read = { ...workstream('read-row', 'Read destination', 'completed'), participantUserIds: ['user-1'] };
    const unread = { ...workstream('unread-row', 'Unread destination', 'completed'), hasUnread: true, preview: 'Do not display this preview' };
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[read, unread]} /></Tooltip.Provider></MemoryRouter>);
    const readLink = screen.getByRole('link', { name: read.title });
    const unreadLink = screen.getByRole('link', { name: new RegExp(unread.title, 'u') });
    expect(readLink.querySelector('time')).toHaveAttribute('datetime', read.lastActivityAt);
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

  it('omits channel descriptions even when the objective is populated', () => {
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

  // A placement is not a copy: the rows under an expanded Space go through the
  // same component the rest of the sidebar draws a Channel with, so a Channel
  // in two Spaces is one record shown twice rather than two rows that can
  // drift.
  it('given a channel in two spaces, selecting either Space reveals the same Channel', () => {
    const memberId = '00000000-0000-7000-8000-0000000000e1';
    const hiring = space();
    const company = space('00000000-0000-7000-8000-0000000000f3', 'Company');
    const member = placedIn({
      ...workstream(memberId, 'Ship the launch', 'completed'),
      preview: 'Draft the announcement',
    }, hiring.id, company.id);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            spaces={[hiring, company]}
            workspace={workspace}
            workstreams={[member]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    selectSpace('Hiring');
    expect(screen.getAllByRole('link', { name: /Ship the launch/u })).toHaveLength(1);
    selectSpace('Company');
    const row = screen.getByRole('link', { name: /Ship the launch/u });
    expect(row).toHaveClass('sidebar-row', 'workstream-row');
    expect(row.querySelector('.sidebar-row-title')).toHaveTextContent('Ship the launch');
    expect(within(row).getByText('Hiring, Company')).toBeInTheDocument();
  });

  it('falls back to All when a Space route is absent from the active directory', () => {
    const hiring = space();
    render(
      <MemoryRouter initialEntries={['/spaces/archived-space']}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} spaces={[hiring]}
            workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(pill('All')).toHaveAttribute('aria-pressed', 'true');
    expect(pill('Hiring')).toHaveAttribute('aria-pressed', 'false');
  });

  it('filters by a Space pill without navigating or adding a history entry', () => {
    const hiring = space();
    function HistoryProbe() {
      const location = useLocation();
      const navigate = useNavigate();
      return <>
        <output aria-label="Current route">{location.pathname}</output>
        <button onClick={() => navigate(-1)} type="button">Back</button>
      </>;
    }
    render(
      <MemoryRouter initialEntries={['/starting-point']}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} spaces={[hiring]}
            workspace={workspace} workstreams={[]} />
          <HistoryProbe />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    selectSpace('Hiring');
    expect(pill('Hiring')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status', { name: 'Current route' })).toHaveTextContent('/starting-point');
  });

  it('centers the active Channel when a deep link opens', async () => {
    const other = space('00000000-0000-7000-8000-0000000000a1', 'Other');
    const hiring = space('00000000-0000-7000-8000-0000000000a2', 'Hiring');
    const target = placedIn(workstream('deep-linked-channel', 'Deep linked', 'completed'), hiring.id);
    const neighbor = placedIn(workstream('ordinary-navigation', 'Ordinary navigation', 'completed'), hiring.id);
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function scrollIntoView(this: Element) {
      scrolled.push(this);
    });
    markDeepLinkWorkstreamNavigation(target.id);

    render(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()}
            spaces={[other, hiring]} workspace={workspace} workstreams={[target, neighbor]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    // Under All the Channel is already in the list, so only its row moves;
    // no pill is revealed because no filter was chosen.
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled.map((row) => row.getAttribute('data-space-id')).filter(Boolean)).toEqual([]);
    expect(scrolled.map((row) => row.getAttribute('data-workstream-id')).filter(Boolean)).toEqual([target.id]);
    for (const call of vi.mocked(Element.prototype.scrollIntoView).mock.calls) {
      expect(call[0]).toEqual({ block: 'center', behavior: 'auto' });
    }
    expect(pill('All')).toHaveAttribute('aria-pressed', 'true');

    markDeepLinkWorkstreamNavigation(target.id);
    await waitFor(() => expect(scrolled).toHaveLength(2));

    fireEvent.click(screen.getByRole('link', { name: /Ordinary navigation/u }));
    expect(scrolled).toHaveLength(2);
  });

  it('waits for the live Space hierarchy before consuming a deep-link reveal', async () => {
    const hiring = space('00000000-0000-7000-8000-0000000000a2', 'Hiring');
    const target = placedIn(workstream('waiting-deep-link', 'Waiting deep link', 'completed'), hiring.id);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    markDeepLinkWorkstreamNavigation(target.id);
    const view = render(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} spaces={[]}
            spacesReady={false} workspace={workspace} workstreams={[target]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
    view.rerender(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} spaces={[hiring]}
            spacesReady workspace={workspace} workstreams={[target]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  });

  it('loads directory pages until a deep-linked Channel can reveal its hierarchy', async () => {
    const hiring = space('00000000-0000-7000-8000-0000000000a2', 'Hiring');
    const target = placedIn(workstream('paged-deep-link', 'Paged deep link', 'completed'), hiring.id);
    const firstPage = placedIn(workstream('first-page-channel', 'First page channel', 'completed'), hiring.id);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const onLoadMoreWorkstreams = vi.fn();
    markDeepLinkWorkstreamNavigation(target.id);
    const view = render(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} hasMoreWorkstreams onLoadMoreWorkstreams={onLoadMoreWorkstreams}
            onSignOut={vi.fn()} spaces={[hiring]} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(onLoadMoreWorkstreams).toHaveBeenCalledOnce());
    expect(scrollIntoView).not.toHaveBeenCalled();
    view.rerender(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} hasMoreWorkstreams onLoadMoreWorkstreams={onLoadMoreWorkstreams}
            onSignOut={vi.fn()} spaces={[hiring]} workspace={workspace} workstreams={[firstPage]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(onLoadMoreWorkstreams).toHaveBeenCalledTimes(2));
    view.rerender(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onLoadMoreWorkstreams={onLoadMoreWorkstreams}
            onSignOut={vi.fn()} spaces={[hiring]} workspace={workspace} workstreams={[firstPage, target]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  });

  it('cancels a pending deep-link reveal when navigation leaves its route', async () => {
    const hiring = space('00000000-0000-7000-8000-0000000000a2', 'Hiring');
    const target = placedIn(workstream('stale-deep-link', 'Stale deep link', 'completed'), hiring.id);
    const neighbor = placedIn(workstream('different-channel', 'Different channel', 'completed'), hiring.id);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    markDeepLinkWorkstreamNavigation(target.id);
    function Navigation() {
      const navigate = useNavigate();
      const [items, setItems] = useState([neighbor]);
      return <>
        <button onClick={() => navigate(`/workstreams/${neighbor.id}`)}>Leave deep link</button>
        <button onClick={() => {
          setItems([target, neighbor]);
          navigate(`/workstreams/${target.id}`);
        }}>Open restored channel</button>
        <Sidebar {...defaultActions} loading onSignOut={vi.fn()}
          spaces={[hiring]} workspace={workspace} workstreams={items} />
      </>;
    }
    render(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider><Navigation /></Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Leave deep link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open restored channel' }));
    await screen.findByRole('link', { name: /Stale deep link/u });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not start navigation telemetry when the active channel row is clicked again', () => {
    const active = workstream('active-workstream', 'Already open', 'completed');
    render(
      <MemoryRouter initialEntries={[`/workstreams/${active.id}`]}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
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
          <Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
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

  // Where the sidebar is actually drawn. The grab measures the panel rather than
  // reading the width state, so jsdom — which lays nothing out and reports every
  // rect as zero — has to be told, and these tests are about geometry.
  function layOutPanelAt(right: number): void {
    vi.spyOn(screen.getByRole('complementary', { name: 'Rally navigation' }), 'getBoundingClientRect')
      .mockReturnValue({ bottom: 900, height: 900, left: 0, right, toJSON: () => ({}), top: 0, width: right, x: 0, y: 0 });
  }

  // The handle stands in a strip beside the sidebar rather than on its edge, so
  // a grab at the far side of that strip must still move the sidebar by what
  // the pointer moves rather than snapping the edge out to meet it.
  it('drags from wherever the handle was grabbed without snapping the edge to the pointer', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const resizer = screen.getByRole('separator', { name: 'Resize navigation' });
    resizer.setPointerCapture = vi.fn();
    layOutPanelAt(300);

    fireEvent.pointerDown(resizer, { clientX: 318, pointerId: 3 });
    expect(resizer).toHaveFocus();
    fireEvent.pointerMove(window, { clientX: 318, pointerId: 3 });
    expect(document.querySelector('.sidebar-drag-guide')).not.toBeNull();
    expect(resizer).toHaveAttribute('aria-valuenow', '300');

    fireEvent.pointerMove(window, { clientX: 358, pointerId: 3 });
    expect(resizer).toHaveAttribute('aria-valuenow', '340');

    fireEvent.pointerUp(window, { pointerId: 3 });
    expect(document.querySelector('.sidebar-drag-guide')).toBeNull();
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
            loading
            onSignOut={vi.fn()}
            spaces={[]}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    // The Channel list holds seven glyph rows, ungrouped as the list under a
    // Space is; the pill strip draws no pills until its directory arrives.
    expect(container.querySelectorAll('.skeleton-row')).toHaveLength(7);
    expect(container.querySelectorAll('.skeleton-row-mark.is-glyph')).toHaveLength(7);
    expect(container.querySelector('.skeleton-group-label')).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Spaces' })).queryAllByRole('button')).toHaveLength(0);
    // Said once for the whole wait, not once per section and not once per row.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText('Loading your spaces and channels')).toBeInTheDocument();
    // Nothing claims the sidebar is empty while it is still arriving.
    expect(screen.queryByText('No active automations')).not.toBeInTheDocument();
    expect(screen.queryByText('No spaces yet')).not.toBeInTheDocument();
    expect(screen.queryByText('No channels yet')).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            loading={false}
            onSignOut={vi.fn()}
            spaces={[]}
            workspace={workspace}
            workstreams={[workstream('00000000-0000-4000-8000-000000000030', 'Launch brief', 'running')]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(container.querySelectorAll('.skeleton-row')).toHaveLength(0);
    expect(screen.getByText('Launch brief')).toBeInTheDocument();
  });

  it('does not render the disabled onboarding checklist', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('region', { name: 'Get started with Rally' })).not.toBeInTheDocument();
  });

  it('leaves channel glyphs whole and shows one ranked marker per row', () => {
    render(
      <MemoryRouter initialEntries={['/workstreams/input']}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[
              workstream('input', 'Board decision', 'needs_input'),
              workstream('running', 'Pricing restructure', 'running'),
              workstream('completed', 'Missing sidebar row', 'completed'),
              workstream('scheduled', 'Monday review', 'scheduled'),
              workstream('automation', 'PostHog follow-up', 'completed'),
              workstream('completed-unread', 'Completed unread', 'completed', undefined, { hasUnread: true }),
              workstream('completed-mentioned', 'Completed mention', 'completed', undefined, { youAreMentioned: true }),
              workstream('completed-unseen', 'Completed unseen', 'completed', undefined, { unseen: true }),
              workstream('scheduled-mentioned', 'Scheduled mention', 'scheduled', undefined, { youAreMentioned: true }),
            ]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(document.querySelectorAll('.workstream-row-status')).toHaveLength(0);
    // One ranked dot per row; a finished run is the ordinary state and has none.
    expect(markerOf('Board decision')).toBe('Needs input');
    expect(markerOf('Pricing restructure')).toBe('Running');
    expect(markerOf('Monday review')).toBe('Running');
    expect(markerOf('Missing sidebar row')).toBeNull();
    expect(markerOf('Completed unread')).toBe('Unread');
    expect(markerOf('Completed mention')).toBe('You were mentioned');
    expect(markerOf('Completed unseen')).toBe('New to you');
    expect(markerOf('Scheduled mention')).toBe('You were mentioned');
    expect(screen.getByRole('link', { name: 'Board decision, 1 conversation needs attention' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Completed mention, 1 conversation needs attention' })).toBeInTheDocument();
    expect(within(screen.getByRole('link', { name: /Missing sidebar row/u })).queryByText(/needs attention/u)).not.toBeInTheDocument();
    expect(document.querySelector('.sidebar-automation-marker')).toBeNull();
    expect(screen.queryByRole('img', { name: /Automation-generated/u })).not.toBeInTheDocument();
    expect(document.querySelector('.brand-lockup')).toBeNull();
  });

  it('counts Main and Breakout attention together on a Channel row and marks Breakout news as unread', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[
              { ...workstream('active-breakouts', 'Launch', 'completed', undefined, { hasUnread: true }), breakoutAttentionCount: 2 },
              { ...workstream('guest-breakout', 'Shared channel', 'completed', undefined, { hasUnread: true }),
                associativeSubstreamId: '00000000-0000-7000-8000-000000000099', breakoutAttentionCount: 1 },
              { ...workstream('quiet-breakouts', 'Roadmap', 'completed'), breakoutAttentionCount: 0 },
            ]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const launch = screen.getByRole('link', { name: 'Launch, 3 conversations need attention' });
    // The count is not drawn as a badge any more; a Breakout's news is the
    // row's unread marker.
    expect(within(launch).queryByText('3')).not.toBeInTheDocument();
    expect(markerOf('Launch')).toBe('Unread');
    expect(screen.getByRole('link', { name: 'Shared channel, 1 conversation needs attention' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Roadmap' })).toBeInTheDocument();
    expect(markerOf('Roadmap')).toBeNull();
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
    // On the second line, under the time, rather than in a column of its own.
    expect(marker.closest('.channel-row-second')).not.toBeNull();
    expect(within(screen.getByRole('link', { name: /Deploy finished/u }))
      .queryByRole('img', { name: /Active timer/u })).not.toBeInTheDocument();

    fireEvent.pointerMove(marker, { pointerType: 'mouse' });
    expect(await screen.findByText(`Next: ${formatDateTime(dueAt)}`)).toBeVisible();
    expect(screen.getByText('Check whether production deploy completed…')).toBeVisible();
  });

  it('waits for a name rather than showing the request a channel was created from', () => {
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
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[naming, workstream('named', 'Board decision', 'needs_input')]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const row = screen.getByRole('link', { name: /naming this channel/u });
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
              onSignOut={vi.fn()}
              workspace={workspace}
              workstreams={[naming, undated]}
            />
          </Tooltip.Provider>
        </MemoryRouter>,
      );

      expect(screen.getByRole('link', { name: /naming this channel/u })).toBeInTheDocument();
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

  it('renders only populated recency sections and keeps status from changing row order', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T20:00:00.000Z'));

    try {
      render(
        <MemoryRouter>
          <Tooltip.Provider>
            <Sidebar
              {...defaultActions}
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
      expect(screen.queryByRole('heading', { name: 'Channels' })).not.toBeInTheDocument();
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
    ['Mark all as read', 'mark_read', 'marked as read', false],
    ['Archive all', 'archive', 'archived', true],
  ] as const)('confirms the %s grouping action with the server-side total', async (
    menuLabel,
    updateKind,
    resultCopy,
    accessSupported,
  ) => {
    const onPreviewWorkstreamBatch = vi.fn<(filter: unknown) => Promise<{ matchedCount: number; matchedNoteCount: number }>>(async () => ({ matchedCount: 20, matchedNoteCount: 0 }));
    const onApplyWorkstreamBatch = vi.fn(async () => ({ enqueuedCount: 20, archivedNoteCount: 0 }));
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onApplyWorkstreamBatch={onApplyWorkstreamBatch}
            onPreviewWorkstreamBatch={onPreviewWorkstreamBatch}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[{ ...workstream('recent', 'Recent planning', 'completed', new Date().toISOString()),
              ...(accessSupported ? { lastAccessedAt: new Date().toISOString() } : {}),
            }]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Last hour actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: menuLabel }));

    await waitFor(() => expect(onPreviewWorkstreamBatch).toHaveBeenCalled());
    if (accessSupported) expect(onPreviewWorkstreamBatch.mock.calls[0]?.[0]).toHaveProperty('recency', 'access');
    else expect(onPreviewWorkstreamBatch.mock.calls[0]?.[0]).not.toHaveProperty('recency');
    const dialog = await screen.findByRole('dialog', { name: menuLabel });
    await waitFor(() => expect(dialog).toHaveTextContent(
      new RegExp(`20 channels.*will be ${resultCopy}`, 'u'),
    ));
    expect(onPreviewWorkstreamBatch).toHaveBeenCalledWith(expect.objectContaining({
      includeSystem: false,
      lastActivityAt: expect.objectContaining({ atOrAfter: expect.any(String) }),
    }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onApplyWorkstreamBatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ includeSystem: false }),
      { kind: updateKind },
    ));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: menuLabel })).not.toBeInTheDocument());
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
    await waitFor(() => expect(dialog).toHaveTextContent('20 channels'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(dialog).toHaveTextContent('The channels couldn’t be updated. Try again.'));
    expect(dialog).not.toHaveTextContent('One Queue chunk was not published.');
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

  it('manages Sidekicks through the library instead of listing them in the sidebar', () => {
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    expect(screen.queryByRole('region', { name: 'Automations' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'New automation' })).toBeNull();
  });

  it('archives a channel from the menu once the confirmation is accepted', async () => {
    const onArchiveWorkstream = vi.fn(async () => undefined);
    const target = workstream('archive-me', 'Quarterly planning', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
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
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive channel' }));

    // Cancelling is the whole point of confirming: a right-click that landed a
    // row away from where it was aimed must not have archived anything.
    const dialog = await screen.findByRole('dialog', { name: 'Archive channel' });
    expect(within(dialog).getByText('Quarterly planning')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive channel' }))
      .not.toBeInTheDocument());
    expect(onArchiveWorkstream).not.toHaveBeenCalled();

    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive channel' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Archive channel' }))
      .getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(onArchiveWorkstream).toHaveBeenCalledWith(target));
    await waitFor(() => expect(reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'workstream_action_completed', workstreamId: target.id, action: 'archive',
      visibility: 'public', origin: 'ad_hoc', pinned: false,
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive channel' }))
      .not.toBeInTheDocument());
  });

  it('reports a channel archive the server rejected instead of failing silently', async () => {
    const onArchiveWorkstream = vi.fn(async () => {
      throw new Error('The channel could not be reached.');
    });
    const target = workstream('archive-me', 'Quarterly planning', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
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
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive channel' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Archive channel' }))
      .getByRole('button', { name: 'Archive' }));

    const failure = await screen.findByRole('dialog', { name: 'Channel could not be archived' });
    expect(failure).not.toHaveTextContent('The channel could not be reached.');
    // The copy line, not only the message: it is the sentence that tells the
    // reader the row survived, which is the whole reason this dialog exists.
    expect(within(failure).getByText('The channel is still in the sidebar. Try again in a moment.'))
      .toBeVisible();

    fireEvent.click(within(failure).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Channel could not be archived' }))
      .not.toBeInTheDocument());
    // The row is still there, and saying so is the reason this dialog exists:
    // the sidebar looks identical either way, so a silent failure reads as an
    // archive the list has simply not caught up with yet.
    expect(screen.getByRole('link', { name: /Quarterly planning/u })).toBeVisible();
    expect(reportTelemetryProductIntent).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'archive' }),
    );
  });

  describe('from empty list space', () => {
    const openBrowserImport = vi.fn(async () => undefined);
    beforeEach(() => vi.stubGlobal('rally', { openBrowserImport }));
    afterEach(() => vi.unstubAllGlobals());

    it('offers channel creation locked to the selected Space from empty list space', async () => {
      const hiring = space();
      const target = placedIn(workstream('empty-area', 'Quarterly planning', 'completed'), hiring.id);
      render(
        <MemoryRouter>
          <Tooltip.Provider>
            <Sidebar {...defaultActions} onSignOut={vi.fn()}
              spaces={[general(), hiring]} workspace={workspace} workstreams={[target]} />
          </Tooltip.Provider>
        </MemoryRouter>,
      );
      selectSpace('Hiring');

      // A row keeps its own menu.
      fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
      expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Start New Channel' })).toBeNull();
      // Its items sit in a portal, which React still bubbles through the list.
      fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Rename' }), { clientX: 130, clientY: 95 });
      expect(screen.queryByRole('menuitem', { name: 'Start New Channel' })).toBeNull();
      fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rename' }), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull());

      fireEvent.contextMenu(screen.getByRole('navigation', { name: 'Channels' }), { clientX: 120, clientY: 300 });
      await screen.findByRole('menuitem', { name: 'Start New Channel' });
      expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
        'Start New Channel',
        'Import Channel from Claude or ChatGPT',
      ]);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Import Channel from Claude or ChatGPT' }));
      expect(openBrowserImport).toHaveBeenCalledWith({
        spaces: [{ id: hiring.id, name: 'Hiring' }],
        spaceLocked: true,
      });

      fireEvent.contextMenu(screen.getByRole('navigation', { name: 'Channels' }), { clientX: 120, clientY: 300 });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Start New Channel' }));
      const dialog = await screen.findByRole('dialog', { name: 'Start a new channel' });
      const picker = within(dialog).getByRole('combobox', { name: 'Space' });
      expect(picker).toHaveTextContent('Hiring');
      expect(picker).toBeDisabled();
    });
  });

  it('shows the current and other existing placements as checked choices', async () => {
    const hiring = space();
    const launch = space('00000000-0000-7000-8000-0000000000f5', 'Launch');
    const target = placedIn(
      workstream('menu-spaces', 'Quarterly planning', 'completed'),
      hiring.id,
      general().id,
    );
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            spaces={[general(), launch, hiring]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(pillNames()).toEqual(['All', 'Hiring', 'Launch']);

    // The row lives under the Space that holds it; there is no second, flat
    // list of the same Channel to reach it through.
    selectSpace('Hiring');
    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u })!, { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Archive channel' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to space' }));
    const generalOption = await screen.findByRole('menuitemcheckbox', { name: 'General' });
    const existing = screen.getByRole('menuitemcheckbox', { name: 'Hiring' });
    const available = screen.getByRole('menuitemcheckbox', { name: 'Launch' });
    // The pills' A–Z order, with General — which has no pill — sorted among them.
    expect(screen.getAllByRole('menuitemcheckbox').map((option) => option.textContent))
      .toEqual(['General', 'Hiring', 'Launch']);
    expect(generalOption).toHaveAttribute('aria-checked', 'true');
    expect(generalOption.firstElementChild).toHaveClass('nested-menu-check');
    expect(existing).toHaveAttribute('data-disabled');
    expect(existing).toHaveAttribute('aria-disabled', 'true');
    expect(existing).toHaveAttribute('aria-checked', 'true');
    expect(existing.firstElementChild).toHaveClass('nested-menu-check');
    expect(existing.children[1]).toHaveTextContent('Hiring');
    expect(available).toHaveAttribute('aria-checked', 'false');
    expect(available.firstElementChild).not.toHaveClass('nested-menu-check');

    act(() => available.focus());
    fireEvent.keyDown(available, { key: 'ArrowUp' });
    await waitFor(() => expect(existing).toHaveFocus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'This channel is already in Hiring.',
    );
  });

  it('orders the new Channel Space picker like the Space pills', async () => {
    const hiring = space();
    const launch = space('00000000-0000-7000-8000-0000000000f5', 'Launch');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            spaces={[general(), launch, hiring]}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(pillNames()).toEqual(['All', 'Hiring', 'Launch']);
    fireEvent.click(screen.getByRole('button', { name: 'New channel' }));

    const dialog = screen.getByRole('dialog', { name: 'Start a new channel' });
    const spacePicker = within(dialog).getByRole('combobox', { name: 'Space' });
    expect(spacePicker).toHaveTextContent('General');
    fireEvent.click(spacePicker);
    expect(screen.getAllByRole('option').map((option) => option.textContent))
      .toEqual(['General', 'Hiring', 'Launch']);
  });

  it('removes a channel from the space whose placement menu was opened', async () => {
    const hiring = space();
    const launch = space('00000000-0000-7000-8000-0000000000f5', 'Launch');
    const onRemoveChannelFromSpace = vi.fn(async () => undefined);
    // Hiring is deliberately second: choosing the first membership from the
    // Channel instead of the placement whose row was opened must fail here.
    const target = placedIn(
      workstream('remove-placement', 'Quarterly planning', 'completed'),
      launch.id,
      hiring.id,
    );
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onRemoveChannelFromSpace={onRemoveChannelFromSpace}
            onSignOut={vi.fn()}
            spaces={[launch, hiring]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    selectSpace('Hiring');
    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), {
      clientX: 120,
      clientY: 90,
    });

    const menuItems = await screen.findAllByRole('menuitem');
    expect(menuItems.slice(-2).map((item) => item.textContent?.trim())).toEqual([
      'Remove from space',
      'Archive channel',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from space' }));

    await waitFor(() => expect(onRemoveChannelFromSpace).toHaveBeenCalledWith(hiring.id, target.id));
  });

  it('explains that a channel cannot be removed from its final space', async () => {
    const hiring = space();
    const target = placedIn(workstream('final-placement', 'Quarterly planning', 'completed'), hiring.id);
    const onRemoveChannelFromSpace = vi.fn(async () => {
      throw new ApiError('A Channel belongs to no other Space', 409, 'space_membership_final');
    });
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onRemoveChannelFromSpace={onRemoveChannelFromSpace}
            onSignOut={vi.fn()}
            spaces={[hiring]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    selectSpace('Hiring');
    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), {
      clientX: 120,
      clientY: 90,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from space' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Channel could not be removed from that space',
    });
    expect(within(dialog).getByText('A channel must be in at least one space.')).toBeVisible();
  });

  it('preserves the actionable copy for another named removal refusal', async () => {
    const hiring = space();
    const target = placedIn(workstream('incompatible-placement', 'Quarterly planning', 'completed'), hiring.id);
    const onRemoveChannelFromSpace = vi.fn(async () => {
      throw new ApiError('Readers would lose their remaining Space', 409, 'space_audience_incompatible');
    });
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onRemoveChannelFromSpace={onRemoveChannelFromSpace}
            onSignOut={vi.fn()}
            spaces={[hiring]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    selectSpace('Hiring');
    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), {
      clientX: 120,
      clientY: 90,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from space' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Channel could not be removed from that space',
    });
    expect(within(dialog).getByText(
      'Some people who can read the channel would be left with no space to find it in. Add it to a space they can see first.',
    )).toBeVisible();
  });

  // A Space this reader reaches only through a Channel in it is visible and
  // read-only. The menu keeps the visible row and explains why it cannot be a
  // destination instead of looking like a second, incomplete Space directory.
  it('shows a space reached through a channel as disabled and explains why', async () => {
    const reached = space('00000000-0000-7000-8000-0000000000f4', 'Theirs', {
      reach: 'through_channel',
      participants: [],
      channelCount: 1,
    });
    const target = placedIn(workstream('menu-reach', 'Quarterly planning', 'completed'), general().id);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            spaces={[general(), reached]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u })!, { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to space' }));

    const generalOption = await screen.findByRole('menuitemcheckbox', { name: 'General' });
    const readOnly = screen.getByRole('menuitemcheckbox', { name: 'Theirs' });
    expect(readOnly).toHaveAttribute('data-disabled');
    expect(readOnly).toHaveAttribute('aria-disabled', 'true');
    expect(readOnly).toHaveAttribute('aria-checked', 'false');

    act(() => generalOption.focus());
    fireEvent.keyDown(generalOption, { key: 'ArrowDown' });
    await waitFor(() => expect(readOnly).toHaveFocus());
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(
      'You can view Theirs through a channel, but only Theirs participants can add channels.',
    ));
  });

  // A system Channel is not a product Channel: the subsystem that writes it
  // decides both who reads it and where it lives, so neither control is raised.
  it('given a system channel, when the row menu opens, then no space control is offered', async () => {
    const hiring = space();
    const digest = placedIn({
      ...workstream('menu-system-spaces', 'Digest · Adam', 'completed'),
      systemKind: 'digest',
    }, hiring.id);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            spaces={[hiring]}
            workspace={workspace}
            workstreams={[digest]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    selectSpace('Hiring');
    fireEvent.contextMenu(screen.getByRole('link', { name: /Digest/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Add to space' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Manage access' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Remove from space' })).not.toBeInTheDocument();
  });

  it('moves a channel from the selected Space to the pill its row was dropped on', () => {
    const onMoveChannelToSpace = vi.fn(async () => undefined);
    const hiring = space();
    const launch = space('00000000-0000-7000-8000-0000000000f5', 'Launch');
    const target = placedIn(workstream('drag-to-space', 'Quarterly planning', 'completed'), launch.id);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onMoveChannelToSpace={onMoveChannelToSpace}
            onSignOut={vi.fn()}
            spaces={[general(), launch, hiring]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
    selectSpace('Launch');

    const row = document.querySelector(`[data-workstream-id="${target.id}"]`);
    if (!(row instanceof HTMLElement)) throw new Error('channel row missing');
    expect(row).toHaveAttribute('draggable', 'true');
    // The payload the row itself writes is the one the pill reads back.
    const transfer = recordingDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: transfer });
    fireEvent.dragEnter(pill('Hiring'), { dataTransfer: transfer });
    fireEvent.drop(pill('Hiring'), { dataTransfer: transfer });

    expect(onMoveChannelToSpace).toHaveBeenCalledWith(launch.id, hiring.id, target.id);
  });

  // The section is showing its opening card and no rows, so there is nothing to
  // drop a Channel on and nothing to add it to — the server refuses either with
  // `space_bootstrap_pending`.
  // The guest shell is handed no directory at all: guest access to Spaces is
  // deferred, and the host decides that rather than the sidebar inferring it
  // from controls that would only be refused.
  it('given no space directory, then the sidebar draws no space navigation', async () => {
    const target = workstream('guest-shell', 'Quarterly planning', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('group', { name: 'Spaces' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New space' })).not.toBeInTheDocument();
    expect(screen.queryByText('No spaces yet')).not.toBeInTheDocument();
    expect(document.querySelector(`[data-workstream-id="${target.id}"]`))
      .not.toHaveAttribute('draggable', 'true');

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Add to space' })).not.toBeInTheDocument();
  });

  it('shows the organization-opening state instead of a half-built hierarchy', async () => {
    const target = workstream('opening-state', 'Quarterly planning', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            spaces={[general()]}
            spacesReady={false}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByText('Opening this organization…')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /General/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New space' })).not.toBeInTheDocument();
    expect(document.querySelector(`[data-workstream-id="${target.id}"]`))
      .not.toHaveAttribute('draggable', 'true');

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Add to space' })).not.toBeInTheDocument();
  });

  it('keeps the spaces it has and offers a retry when the directory is out of date', () => {
    const onRetrySpaces = vi.fn();
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onRetrySpaces={onRetrySpaces}
            onSignOut={vi.fn()}
            spaces={[general(), space()]}
            spacesOutOfDate
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(pill('Hiring')).toBeVisible();
    expect(screen.queryByText('These spaces may be out of date.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRetrySpaces).toHaveBeenCalled();
  });

  it('opens the same Channel after switching between either containing Space', () => {
    const hiring = space();
    const launch = space('00000000-0000-7000-8000-0000000000f3', 'Launch');
    const target = placedIn(workstream('two-places', 'Quarterly planning', 'completed'), hiring.id, launch.id);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            spaces={[hiring, launch]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    selectSpace('Hiring');
    expect(screen.getByRole('link', { name: /Quarterly planning/u })).toHaveAttribute('href', `/workstreams/${target.id}`);
    selectSpace('Launch');
    expect(screen.getByRole('link', { name: /Quarterly planning/u })).toHaveAttribute('href', `/workstreams/${target.id}`);
  });

  it('marks channels unread on the server and renames from the menu', async () => {
    const onMarkWorkstreamUnread = vi.fn(async () => undefined);
    const onRenameWorkstream = vi.fn(async () => undefined);
    const target = workstream('rename-me', 'Quarterly planning', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
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

    expect(screen.queryByRole('menuitem', { name: 'Pin' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Archive channel' })).toHaveClass('menu-item-danger');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as unread' }));
    await waitFor(() => expect(onMarkWorkstreamUnread).toHaveBeenCalledWith(target));
    await waitFor(() => expect(reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'workstream_action_completed', workstreamId: target.id, action: 'mark_unread',
      visibility: 'public', origin: 'ad_hoc', pinned: false,
    }));

    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByRole('textbox', { name: 'Channel name' });
    fireEvent.change(input, { target: { value: 'Launch planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(onRenameWorkstream).toHaveBeenCalledWith(target, 'Launch planning'));
    await waitFor(() => expect(reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'workstream_action_completed', workstreamId: target.id, action: 'rename',
      visibility: 'public', origin: 'ad_hoc', pinned: false,
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename channel' })).not.toBeInTheDocument());
  });
});

describe('private channels', () => {

  beforeEach(() => {
    window.localStorage.clear();
    markWorkstreamNavigation.mockReset();
    reportTelemetryProductIntent.mockReset();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300, sidebarSpaceFilter: null });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function renderWith(streams: WorkstreamSummary[]): void {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
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
    expect(screen.queryByLabelText('Private channel')).not.toBeInTheDocument();
    expect(row.querySelector('.sidebar-workstream-facepile')).toBeNull();
  });

  it('reaches a keyboard reader through the row preview the globe tip cannot', async () => {
    renderWith([workstream('00000000-4000-4000-8000-00000000003a', 'Launch', 'completed')]);
    const row = screen.getByRole('link', { name: 'Launch' });

    // Tabbing to the row is the whole keyboard gesture: the globe itself is a
    // `span` inside this link, and giving it a tab stop would put one on every
    // public row. The preview opens on focus, so that is where the scope has to
    // be named for anyone who never touches a pointer.
    act(() => row.focus());
    await waitFor(
      () => expect(screen.getByRole('tooltip', { name: /Launch/u })).toHaveTextContent('Public to organization'),
      { timeout: 5_000 },
    );
  });

  it('leaves the scope line off a preview for a channel that is not public', async () => {
    renderWith([{
      ...workstream('00000000-4000-4000-8000-00000000003b', 'Launch', 'completed'),
      scope: 'personal',
    }]);
    const row = screen.getByRole('link', { name: 'Launch' });

    act(() => row.focus());
    await waitFor(() => expect(screen.getByRole('tooltip', { name: /Launch/u })).toBeInTheDocument(), { timeout: 5_000 });
    expect(screen.queryByText('Public to organization')).not.toBeInTheDocument();
  });

  it('marks an organization-scoped channel as public', () => {
    renderWith([{
      ...workstream('00000000-4000-4000-8000-000000000022', 'Launch', 'completed'),
      // Participant presence remains visible even when the work stream is
      // available to the whole workspace.
      participantUserIds: ['user-1', 'user-2'],
      participantExtraCount: 3,
      spaceIds: [],
    }]);

    const row = screen.getByRole('link', { name: /Launch/u });
    // Said in the row's description rather than as a badge on its glyph.
    expect(row).toHaveAccessibleDescription('Public channel');
    expect(row.querySelector('.sidebar-workstream-public')).toBeNull();
    expect(screen.queryByLabelText('Private channel')).not.toBeInTheDocument();
    expect(row.querySelector('.sidebar-workstream-facepile')).toBeNull();
  });

  // **Make private** is gone. A Channel's readers are the union of its own
  // scope and every active Space that holds it, so the row cannot answer
  // whether it is private — the dialog reads the sources and says. What it then
  // offers is covered in `manage-access-dialog.test.tsx`.
  it('offers Manage access in place of the old visibility toggle', async () => {
    renderWith([workstream('00000000-4000-4000-8000-000000000023', 'Launch', 'completed')]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Manage access' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Make private' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Make public to organization' })).not.toBeInTheDocument();
  });

  // A system work stream takes its audience from the subsystem, so the menu
  // does not offer a change that would not happen.
  it('does not offer the toggle on a channel that belongs to Rally itself', async () => {
    renderWith([{
      ...workstream('00000000-4000-4000-8000-000000000027', 'Digest · Adam', 'completed'),
      scope: 'personal',
      systemKind: 'digest',
    }]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Digest/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Manage access' })).not.toBeInTheDocument();
  });
});

/**
 * Switching back into Rally is the one gesture that produces hover and focus
 * without a hand behind either: the row the reader clicked to get here still
 * holds focus, and the row the window came forward underneath is entered by a
 * cursor that never moved. The card is a reading surface the person did not ask
 * for, drawn over the screen they switched back to read.
 *
 * The guard is `lib/window-activation.ts`; these cover what the sidebar does
 * with the answer.
 */
describe('channel rows after an application switch', () => {
  let stopTracking: (() => void) | null = null;

  beforeEach(() => {
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300, sidebarSpaceFilter: null });
    // The app installs this once per window, in `App`. These render the sidebar
    // alone, so the tracking is installed alongside it.
    stopTracking = installWindowActivationTracking();
  });

  afterEach(() => {
    stopTracking?.();
    stopTracking = null;
  });

  function renderWith(streams: WorkstreamSummary[]): void {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={streams}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
  }

  /** Away and back, with nothing else touched: a Command-Tab in both directions. */
  function switchAwayAndBack(): void {
    fireEvent.blur(window);
    fireEvent.focus(window);
  }

  it('leaves the focused row alone when the window hands its focus back', async () => {
    renderWith([workstream('00000000-4000-4000-8000-0000000000f1', 'Launch', 'completed')]);
    const row = screen.getByRole('link', { name: 'Launch' });

    switchAwayAndBack();
    act(() => row.focus());

    await expectNoPreview();
  });

  it('leaves the row the window came forward underneath alone', async () => {
    renderWith([workstream('00000000-4000-4000-8000-0000000000f2', 'Launch', 'completed')]);
    const row = screen.getByRole('link', { name: 'Launch' }).closest('[data-workstream-id]')!;

    switchAwayAndBack();
    fireEvent.pointerOver(row, { clientX: 120, clientY: 260 });
    fireEvent.pointerEnter(row, { clientX: 120, clientY: 260 });
    fireEvent.pointerMove(row, { clientX: 120, clientY: 260 });

    await expectNoPreview();
  });

  it('opens for a pointer that goes on to move over the row it was left on', async () => {
    renderWith([workstream('00000000-4000-4000-8000-0000000000f3', 'Launch', 'completed')]);
    const row = screen.getByRole('link', { name: 'Launch' }).closest('[data-workstream-id]')!;

    switchAwayAndBack();
    fireEvent.pointerOver(row, { clientX: 120, clientY: 260 });
    fireEvent.pointerEnter(row, { clientX: 120, clientY: 260 });

    // The entry is spent, and a hand that carries on across the row it was
    // resting on gets no second one — so movement is what has to open the card
    // the entry declined to.
    fireEvent.pointerMove(row, { clientX: 124, clientY: 262 });

    expect(await screen.findByRole('tooltip', { name: /Launch/u })).toBeInTheDocument();
  });

  it('still opens on a hover that has nothing to do with a switch', async () => {
    renderWith([workstream('00000000-4000-4000-8000-0000000000f4', 'Launch', 'completed')]);
    const row = screen.getByRole('link', { name: 'Launch' }).closest('[data-workstream-id]')!;

    fireEvent.pointerEnter(row, { clientX: 120, clientY: 260 });

    expect(await screen.findByRole('tooltip', { name: /Launch/u })).toBeInTheDocument();
  });

  it('still opens for a reader who tabs to a row after switching back', async () => {
    renderWith([workstream('00000000-4000-4000-8000-0000000000f5', 'Launch', 'completed')]);
    const row = screen.getByRole('link', { name: 'Launch' });

    switchAwayAndBack();
    fireEvent.keyDown(window, { key: 'Tab' });
    act(() => row.focus());

    expect(await screen.findByRole('tooltip', { name: /Launch/u })).toBeInTheDocument();
  });

  it('takes a card down with the window rather than leaving it up for the return', async () => {
    renderWith([workstream('00000000-4000-4000-8000-0000000000f6', 'Launch', 'completed')]);
    const row = screen.getByRole('link', { name: 'Launch' }).closest('[data-workstream-id]')!;

    fireEvent.pointerEnter(row, { clientX: 120, clientY: 260 });
    expect(await screen.findByRole('tooltip', { name: /Launch/u })).toBeInTheDocument();

    // The pointer never leaves the row, so nothing else in the row is going to
    // close this: it is up until the person comes back to find it.
    fireEvent.blur(window);

    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  /**
   * The card opens on a 300ms timer, so a card that is absent on this tick may
   * only be a card that has not arrived yet. Waiting past the timer is what
   * makes the absence mean something.
   */
  async function expectNoPreview(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 600); });
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  }
});

describe('pinned channels', () => {
  // jsdom implements no layout and therefore no `scrollIntoView`; the sidebar
  // calls it optionally for that reason, so a test that wants to observe the
  // call has to put one there.
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    markWorkstreamNavigation.mockReset();
    reportTelemetryProductIntent.mockReset();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300, sidebarSpaceFilter: null, sidebarChannelSort: 'alphabetical' });
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
      onPinWorkstream: (workstream: WorkstreamSummary, spaceId: string, pinned: boolean) => Promise<boolean>;
      onReorderPinnedWorkstreams: (spaceId: string, workstreamIds: string[]) => Promise<void>;
    }> = {},
  ): void {
    // Filtered to the one Space these rows are pinned in, whose pinned run the
    // section draws and a drag rearranges.
    useUiStore.setState({ sidebarSpaceFilter: TEST_SPACE_ID });
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            {...actions}
            spaces={[space(undefined, undefined, { channelCount: streams.length })]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={streams.map((stream) => placedIn(stream, TEST_SPACE_ID))}
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
    if (!wrapper) throw new Error('The channel row has no drag wrapper');
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

  it('lifts a pinned channel out of the recent list into its own section', () => {
    renderWith([
      pinned(workstream('ws-pinned', 'Launch tracking', 'completed'), 0),
      workstream('ws-recent', 'Quarterly planning', 'completed'),
    ]);

    const section = screen.getByRole('region', { name: 'Pinned' });
    expect(within(section).getByRole('link', { name: /Launch tracking/u })).toBeVisible();
    // Once, not twice: the recent list keeps only what is not pinned.
    expect(screen.getAllByRole('link', { name: /Launch tracking/u })).toHaveLength(1);
    expect(within(section).queryByRole('link', { name: /Quarterly planning/u })).not.toBeInTheDocument();
    // With pins above it, the rest of the list is named.
    expect(screen.getByRole('heading', { name: 'Channels' })).toBeVisible();
  });

  it('toggles the unpinned Channels between A to Z and most recent activity', () => {
    renderWith([
      pinned(workstream('ws-pinned', 'Launch tracking', 'completed'), 0),
      workstream('ws-old', 'alpha review', 'completed', '2026-07-01T20:00:00.000Z'),
      workstream('ws-new', 'Zulu sync', 'completed', '2026-07-31T20:00:00.000Z'),
      workstream('ws-mid', 'Bravo notes', 'completed', '2026-07-15T20:00:00.000Z'),
    ]);
    const channelTitles = (): string[] => [...screen.getByRole('region', { name: 'Channels' })
      .querySelectorAll('[data-workstream-id] .sidebar-row-title-copy')]
      .map((title) => title.textContent ?? '');

    // Case-insensitive: the lowercase title still sorts first.
    expect(channelTitles()).toEqual(['alpha review', 'Bravo notes', 'Zulu sync']);

    fireEvent.click(screen.getByRole('button', { name: 'Sorted A to Z. Sort by recent activity' }));
    expect(channelTitles()).toEqual(['Zulu sync', 'Bravo notes', 'alpha review']);
    expect(screen.getByRole('button', { name: 'Sorted by recent activity. Sort A to Z' })).toHaveTextContent('Recent');
    expect(window.localStorage.getItem('rally.sidebar-channel-sort')).toBe('recent');

    fireEvent.click(screen.getByRole('button', { name: 'Sorted by recent activity. Sort A to Z' }));
    expect(channelTitles()).toEqual(['alpha review', 'Bravo notes', 'Zulu sync']);
  });

  it('shows an empty Pinned section that says how to pin, before anything is pinned', () => {
    renderWith([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    const section = screen.getByRole('region', { name: 'Pinned' });
    expect(within(section).getByText('Move a channel here to pin it')).toBeVisible();
    expect(within(section).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Channels' })).not.toBeInTheDocument();
  });

  it('renders pinned rows in their stored order rather than by activity', () => {
    renderWith([
      pinned(workstream('ws-a', 'Alpha', 'completed', '2026-07-31T20:00:00.000Z'), 1),
      pinned(workstream('ws-b', 'Bravo', 'completed', '2026-07-20T20:00:00.000Z'), 0),
    ]);

    expect(pinnedRowTitles()).toEqual([expect.stringContaining('Bravo'), expect.stringContaining('Alpha')]);
    expect(screen.queryByRole('heading', { name: 'Channels' })).not.toBeInTheDocument();
  });

  it('does not navigate behind an open modal dialog', async () => {
    renderWith([
      pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
      pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
    ]);

    const bravo = screen.getByRole('link', { name: /Bravo/u });
    fireEvent.contextMenu(screen.getByRole('link', { name: /Alpha/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    expect(screen.getByRole('dialog', { name: 'Rename channel' })).toBeVisible();

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
      .toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-recent' }), TEST_SPACE_ID, true));

    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch tracking/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
    await waitFor(() => expect(onPinWorkstream)
      .toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-pinned' }), TEST_SPACE_ID, false));
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

    fireEvent.drop(dragTarget(/Alpha/u), { dataTransfer: dataTransfer('move') });
    fireEvent.dragEnd(dragTarget(/Charlie/u), { dataTransfer: dataTransfer('move') });
    await waitFor(() => expect(onReorderPinnedWorkstreams)
      .toHaveBeenCalledWith(TEST_SPACE_ID, ['ws-c', 'ws-a', 'ws-b']));
  });

  it('reorders the full selected-Space arrangement from server-style space pins', async () => {
    const onReorderPinnedWorkstreams = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        { ...pinned(workstream('ws-a', 'Alpha', 'completed'), 0), pinPosition: null },
        { ...pinned(workstream('ws-b', 'Bravo', 'completed'), 1), pinPosition: null },
      ],
      { onReorderPinnedWorkstreams },
    );

    fireEvent.keyDown(screen.getByRole('link', { name: /Bravo/u }), { key: 'ArrowUp', altKey: true });

    await waitFor(() => expect(onReorderPinnedWorkstreams)
      .toHaveBeenCalledWith(TEST_SPACE_ID, ['ws-b', 'ws-a']));
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
      () => expect(onReorderPinnedWorkstreams).toHaveBeenCalledWith(TEST_SPACE_ID, ['ws-b', 'ws-a']),
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
    expect(onReorderPinnedWorkstreams).toHaveBeenNthCalledWith(1, TEST_SPACE_ID, ['ws-a', 'ws-c', 'ws-b']);
    expect(onReorderPinnedWorkstreams).toHaveBeenNthCalledWith(2, TEST_SPACE_ID, ['ws-c', 'ws-a', 'ws-b']);

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

  it('keeps an in-flight pin order scoped to the Space that owns it', async () => {
    const launch = space(TEST_SPACE_ID, 'Launch');
    const hiring = space('00000000-0000-7000-8000-0000000000f3', 'Hiring');
    const settle: (() => void)[] = [];
    const onReorderPinnedWorkstreams = vi.fn(
      () => new Promise<void>((resolve) => settle.push(resolve)),
    );
    const alpha = placedIn(workstream('ws-a', 'Alpha', 'completed'), launch.id, hiring.id);
    const bravo = placedIn(workstream('ws-b', 'Bravo', 'completed'), launch.id, hiring.id);
    render(
      <MemoryRouter><Tooltip.Provider>
        <Sidebar
          {...defaultActions}
          onReorderPinnedWorkstreams={onReorderPinnedWorkstreams}
          onSignOut={vi.fn()}
          spaces={[launch, hiring]}
          workspace={workspace}
          workstreams={[
            { ...alpha, spacePins: [{ spaceId: launch.id, position: 0 }, { spaceId: hiring.id, position: 0 }] },
            { ...bravo, spacePins: [{ spaceId: launch.id, position: 1 }, { spaceId: hiring.id, position: 1 }] },
          ]}
        />
      </Tooltip.Provider></MemoryRouter>,
    );

    selectSpace('Launch');
    fireEvent.keyDown(screen.getByRole('link', { name: /Bravo/u }), { key: 'ArrowUp', altKey: true });
    expect(onReorderPinnedWorkstreams).toHaveBeenCalledWith(launch.id, ['ws-b', 'ws-a']);

    selectSpace('Hiring');
    expect(pinnedRowTitles()).toEqual([
      expect.stringContaining('Alpha'),
      expect.stringContaining('Bravo'),
    ]);

    onReorderPinnedWorkstreams.mockClear();
    fireEvent.keyDown(screen.getByRole('link', { name: /Bravo/u }), { key: 'ArrowUp', altKey: true });
    expect(onReorderPinnedWorkstreams).toHaveBeenCalledWith(hiring.id, ['ws-b', 'ws-a']);

    await act(async () => {
      for (const resolve of settle) resolve();
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
      const [workstreams, setWorkstreams] = useState(
        streams.map((stream) => placedIn(stream, TEST_SPACE_ID)),
      );
      return (
        <Sidebar
          {...defaultActions}
          onPinWorkstream={async (workstream, spaceId, pinned) => {
            pins.push(`${pinned ? 'pin' : 'unpin'}:${workstream.id}`);
            await Promise.resolve();
            setWorkstreams((current) => current.map((item) => item.id === workstream.id
              ? { ...item, spacePins: pinned ? [{ spaceId, position: 0 }] : [] }
              : item));
            return true;
          }}
          onSignOut={vi.fn()}
          spaces={[space(TEST_SPACE_ID, 'Hiring', { channelCount: workstreams.length })]}
          workspace={workspace}
          workstreams={workstreams}
        />
      );
    }
    render(<MemoryRouter><Tooltip.Provider><Harness /></Tooltip.Provider></MemoryRouter>);
    return { pins };
  }

  // The other half of following it: the row travels to the section rather than
  // reappearing there. The motion itself is `useListMotion`'s and is covered
  // in its own file; these prove the sidebar marks its rows so that a row
  // whose element is replaced — by a pin, or by crossing into another recency
  // group — is still seen as one row moving.
  describe('list motion', () => {
    const animate = vi.fn((element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      void element; void keyframes; void options;
      return { cancel: vi.fn(), onfinish: null, oncancel: null };
    });
    const measure = Element.prototype.getBoundingClientRect;

    // Installed and restored here rather than in the bodies: a failing
    // assertion throws past a restore at the end of a case, and the test it
    // leaks into is the one that gets blamed. `animate` is deleted rather
    // than restored because jsdom never defined it, and a stub left behind
    // would hide that gap from every test after these; jsdom does define the
    // measurement, which goes back as it was.
    beforeEach(() => {
      animate.mockClear();
      vi.useFakeTimers({ now: new Date('2026-08-01T12:00:00.000Z'), toFake: ['Date'] });
      Element.prototype.animate = function animateStub(
        this: Element,
        keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
        options?: number | KeyframeAnimationOptions,
      ): Animation {
        return animate(this, keyframes as Keyframe[], options as KeyframeAnimationOptions) as unknown as Animation;
      };
      // jsdom lays nothing out: rows and headings sit one slot apart in
      // document order under the scroll box, which is what the sidebar's grid
      // lists give.
      Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
        const scroll = this.closest('.sidebar-scroll');
        const index = scroll === null || scroll === this
          ? 0
          : [...scroll.querySelectorAll('[data-motion-key]')].indexOf(this);
        const top = index * 48;
        return { top, left: 12, right: 292, bottom: top + 48, width: 280, height: 48, x: 12, y: top, toJSON: () => ({}) };
      };
    });

    afterEach(() => {
      delete (Element.prototype as Partial<Element>).animate;
      Element.prototype.getBoundingClientRect = measure;
      vi.useRealTimers();
    });

    /** The animation started on the element carrying `key`, if any. */
    function playedOn(key: string): { element: HTMLElement; keyframes: Keyframe[] } | undefined {
      const call = animate.mock.calls.find(([element]) => (element as HTMLElement).dataset.motionKey === key);
      return call ? { element: call[0] as HTMLElement, keyframes: call[1] } : undefined;
    }

    it('moves the row\'s motion with it into the Pinned section', async () => {
      renderPinnable([
        workstream('ws-first', 'Roadmap review', 'completed', '2026-07-31T21:00:00.000Z'),
        workstream('ws-recent', 'Quarterly planning', 'completed'),
      ]);

      fireEvent.contextMenu(screen.getByRole('link', { name: /Roadmap review/u }), { clientX: 120, clientY: 90 });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

      // The animated element is the one the Pinned section now renders, and it
      // rises one slot from the second alphabetical row to the first pinned one,
      // under the Pinned heading that was already there.
      const moved = playedOn('workstream:ws-first');
      expect(moved).toBeDefined();
      expect(screen.getByRole('region', { name: 'Pinned' })).toContainElement(moved!.element);
      expect(moved!.keyframes[0]).toEqual(expect.objectContaining({ transform: 'translate(0px, 48px)' }));
      // The row it passed shifts down two slots: one for the pinned row above
      // it and one for the Channels heading the list now has.
      expect(playedOn('workstream:ws-recent')?.keyframes).toEqual([{ transform: 'translate(0px, -96px)' }, { transform: 'translate(0px, 0px)' }]);
    });

    // `scrollIntoView` scrolls to the box as transformed, and the motion's first
    // frame puts the row back in the slot it left, so a scroll made after the
    // motion started finds the row still on screen where it was and scrolls to
    // nothing. Reproduced in the running client with a scroll box shrunk to
    // two rows: a pin made at the bottom left the pinned section off screen.
    it('scrolls the reveal before the motion starts, since the scroll reads the transformed box', async () => {
      renderPinnable([
        workstream('ws-first', 'Roadmap review', 'completed', '2026-07-31T21:00:00.000Z'),
        workstream('ws-recent', 'Quarterly planning', 'completed'),
      ]);

      fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

      expect(animate).toHaveBeenCalled();
      expect(scrollIntoView.mock.invocationCallOrder[0]).toBeLessThan(Math.min(...animate.mock.invocationCallOrder));
    });

    it('resolves a drag target by the slot laid out under the pointer, not the row drawn there', () => {
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
      // The row the reader is positioning is placed rather than sent out.
      expect(dragTarget(/Charlie/u).closest('[data-motion-key]')).toHaveAttribute('data-motion-hold');
      // The event reaches Alpha's element, but the pointer is over Bravo's
      // slot — the slots run [Pinned heading, Alpha, Bravo, Charlie] — which
      // is where a row gliding under the pointer would have been drawn.
      // jsdom has no `DragEvent`, so the pointer position goes on by hand.
      const over = createEvent.dragOver(dragTarget(/Alpha/u), { dataTransfer: dataTransfer() });
      Object.defineProperty(over, 'clientY', { value: 2 * 48 + 10 });
      fireEvent(dragTarget(/Alpha/u), over);
      expect(pinnedRowTitles()).toEqual([
        expect.stringContaining('Alpha'),
        expect.stringContaining('Charlie'),
        expect.stringContaining('Bravo'),
      ]);
    });

    it('moves one Channel row between the selected Space motion scopes', () => {
      const launch = space('00000000-0000-7000-8000-0000000000f2', 'Launch');
      const hiring = space('00000000-0000-7000-8000-0000000000f3', 'Hiring');
      const member = placedIn(
        workstream('00000000-0000-7000-8000-0000000000e1', 'Roadmap review', 'completed'),
        launch.id,
        hiring.id,
      );
      render(
        <MemoryRouter><Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} spaces={[launch, hiring]} workspace={workspace} workstreams={[member]} />
        </Tooltip.Provider></MemoryRouter>,
      );
      selectSpace('Launch');
      expect(screen.getByRole('link', { name: /Roadmap review/u })
        .closest('[data-motion-scope]')).toHaveAttribute('data-motion-scope', `space:${launch.id}`);
      selectSpace('Hiring');
      expect(screen.getAllByRole('link', { name: /Roadmap review/u })).toHaveLength(1);
      expect(screen.getByRole('link', { name: /Roadmap review/u })
        .closest('[data-motion-scope]')).toHaveAttribute('data-motion-scope', `space:${hiring.id}`);
    });

    // The rows' shapes travel under CSS for as long as the box's width does,
    // and a move planned against positions still in flight would fight that
    // travel. The sidebar hears the platform's own transition events on its
    // layout channel — on the aside itself, since the rows' transitions bubble
    // through it — and holds the motion until they say the layout has settled.
    it('holds the rows\' motion while the sidebar\'s layout is still travelling', () => {
      const today = workstream('ws-today', 'Roadmap review', 'completed', '2026-08-01T09:00:00.000Z');
      const yesterday = workstream('ws-yesterday', 'Quarterly planning', 'completed', '2026-07-31T09:00:00.000Z');
      const view = (streams: WorkstreamSummary[]): React.JSX.Element => (
        <MemoryRouter><Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={streams} />
        </Tooltip.Provider></MemoryRouter>
      );
      // jsdom has no `TransitionEvent`, so the property name goes on by hand.
      const layoutEvent = (type: string): Event => {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, 'propertyName', { value: '--sidebar-compact' });
        return event;
      };
      const { rerender } = render(view([today, yesterday]));
      const aside = screen.getByRole('complementary', { name: 'Rally navigation' });
      // Another property transitioning on the aside — the workspace-switch
      // fade — is not the layout's, and holds nothing.
      const fade = new Event('transitionrun', { bubbles: true });
      Object.defineProperty(fade, 'propertyName', { value: 'opacity' });
      fireEvent(aside, fade);
      fireEvent(aside, layoutEvent('transitionrun'));
      // Touched, so it crosses into Today: a move, were the layout at rest.
      const touched = { ...yesterday, lastActivityAt: '2026-08-01T11:00:00.000Z' };
      rerender(view([today, touched]));
      expect(animate).not.toHaveBeenCalled();
      // A row's own transition ending is not the layout's.
      fireEvent(screen.getByRole('link', { name: /Roadmap review/u }), layoutEvent('transitionend'));
      const aged = { ...today, lastActivityAt: '2026-07-31T10:00:00.000Z' };
      rerender(view([aged, touched]));
      expect(animate).not.toHaveBeenCalled();
      // The render the settling itself causes measures the rows afresh, and
      // the next move plans from those positions: the row travels the two
      // slots from the Yesterday group it was measured in.
      fireEvent(aside, layoutEvent('transitionend'));
      expect(animate).not.toHaveBeenCalled();
      rerender(view([{ ...today, lastActivityAt: '2026-08-01T11:30:00.000Z' }, touched]));
      expect(playedOn('workstream:ws-today')?.keyframes[0]).toEqual(expect.objectContaining({ transform: 'translate(0px, 96px)' }));
    });

    // A toggle reversed mid-flight cancels the running transition and starts
    // another in one style change, and nothing pins which event arrives
    // first. The hold counts runs rather than trusting the last event.
    it('keeps the hold through a reversal whichever order its cancel and run arrive in', () => {
      const today = workstream('ws-today', 'Roadmap review', 'completed', '2026-08-01T09:00:00.000Z');
      const yesterday = workstream('ws-yesterday', 'Quarterly planning', 'completed', '2026-07-31T09:00:00.000Z');
      const view = (streams: WorkstreamSummary[]): React.JSX.Element => (
        <MemoryRouter><Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={streams} />
        </Tooltip.Provider></MemoryRouter>
      );
      const layoutEvent = (type: string): Event => {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, 'propertyName', { value: '--sidebar-compact' });
        return event;
      };
      const { rerender } = render(view([today, yesterday]));
      const aside = screen.getByRole('complementary', { name: 'Rally navigation' });
      fireEvent(aside, layoutEvent('transitionrun'));
      // The reversal's new run lands before the old transition's cancel.
      fireEvent(aside, layoutEvent('transitionrun'));
      fireEvent(aside, layoutEvent('transitioncancel'));
      const touched = { ...yesterday, lastActivityAt: '2026-08-01T11:00:00.000Z' };
      rerender(view([today, touched]));
      expect(animate).not.toHaveBeenCalled();
      // The surviving transition's end is what releases it.
      fireEvent(aside, layoutEvent('transitionend'));
      rerender(view([today, yesterday]));
      expect(playedOn('workstream:ws-yesterday')).toBeDefined();
    });

    // A row leaves one recency group for another whenever it is touched — its
    // heading changes from Yesterday to Today — and the two groups are separate
    // subtrees, so the row is remounted. It is still one row to the reader, and
    // it has to travel between the groups the way it travels between sections.
    it('moves a row\'s motion with it from one recency group to another', () => {
      const today = workstream('ws-today', 'Roadmap review', 'completed', '2026-08-01T09:00:00.000Z');
      const yesterday = workstream('ws-yesterday', 'Quarterly planning', 'completed', '2026-07-31T09:00:00.000Z');
      const { rerender } = render(
        <MemoryRouter><Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[today, yesterday]} />
        </Tooltip.Provider></MemoryRouter>,
      );
      expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Today', 'Yesterday']);

      rerender(
        <MemoryRouter><Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} workspace={workspace} workstreams={[today, { ...yesterday, lastActivityAt: '2026-08-01T11:00:00.000Z' }]} />
        </Tooltip.Provider></MemoryRouter>,
      );

      // A new group opens above for the row, and the row that crossed into it
      // is the one that moved — from two slots down, headings counting as
      // slots, up to the top — while the other row and its heading shift down.
      expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Last hour', 'Today']);
      expect(playedOn('workstream:ws-yesterday')?.keyframes[0]).toEqual(expect.objectContaining({ transform: 'translate(0px, 96px)' }));
      expect(playedOn('workstream:ws-today')?.keyframes).toEqual([{ transform: 'translate(0px, -96px)' }, { transform: 'translate(0px, 0px)' }]);
      expect(playedOn('heading:Today')?.keyframes).toEqual([{ transform: 'translate(0px, -96px)' }, { transform: 'translate(0px, 0px)' }]);
    });
  });

  // Pinning moves the row to a section the reader is very likely scrolled away
  // from — they pinned it because they were tired of hunting for it down the
  // list — so without this the action reads as the row vanishing.
  it('brings a channel back into view once the list carries the pin', async () => {
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
    expect(within(screen.getByRole('region', { name: 'Pinned' })).getByText('Move a channel here to pin it')).toBeVisible();
  });

  // The shell discards a pin response a later one has superseded, so the action
  // behind it has no row movement to follow — and dragging the viewport back to
  // the row the reader has already finished with is worse than doing nothing.
  it('scrolls nothing when a later pin superseded this one', async () => {
    // The list still ends up showing the row pinned, because the newer
    // request's response carried it. Without that the reveal would simply never
    // match and the test would pass whatever the code did.
    function Superseded(): React.JSX.Element {
      const [streams, setStreams] = useState([
        placedIn(workstream('ws-recent', 'Quarterly planning', 'completed'), TEST_SPACE_ID),
      ]);
      return (
        <Sidebar
          {...defaultActions}
          onPinWorkstream={async () => {
            await Promise.resolve();
            setStreams((current) => current.map((item) => ({
              ...item,
              spacePins: [{ spaceId: TEST_SPACE_ID, position: 0 }],
            })));
            return false;
          }}
          onSignOut={vi.fn()}
          spaces={[space(TEST_SPACE_ID, 'Hiring', { channelCount: streams.length })]}
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
    expect(screen.getByRole('link', { name: /Quarterly planning/u }).closest('[data-motion-key]'))
      .not.toHaveAttribute('data-motion-move');
  });

  // Arming the reveal for a row the list does not carry would leave it waiting
  // indefinitely, ready to seize the viewport whenever that work stream
  // reappeared — seconds later, on an unrelated poll.
  it('does not stay armed for a row that leaves the list', async () => {
    const row = placedIn(workstream('ws-gone', 'Quarterly planning', 'completed'), TEST_SPACE_ID);
    function Vanishing(): React.JSX.Element {
      const [streams, setStreams] = useState([row]);
      return (
        <>
          <button onClick={() => setStreams([{
            ...row,
            spacePins: [{ spaceId: TEST_SPACE_ID, position: 0 }],
          }])} type="button">Bring it back</button>
          <Sidebar
            {...defaultActions}
            onPinWorkstream={async () => {
              await Promise.resolve();
              setStreams([]);
              return true;
            }}
            onSignOut={vi.fn()}
            spaces={[space(TEST_SPACE_ID, 'Hiring', { channelCount: streams.length })]}
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
    const revealTimers = vi.spyOn(window, 'setTimeout');
    const row = placedIn(workstream('ws-slow', 'Quarterly planning', 'completed'), TEST_SPACE_ID);
    function Slow(): React.JSX.Element {
      const [streams, setStreams] = useState([row]);
      return (
        <>
          <button onClick={() => setStreams([{
            ...row,
            spacePins: [{ spaceId: TEST_SPACE_ID, position: 0 }],
          }])} type="button">Let it land</button>
          <Sidebar
            {...defaultActions}
            // Reports applied, but the list does not follow — the shape of a
            // response overtaken by a change from another device.
            onPinWorkstream={async () => true}
            onSignOut={vi.fn()}
            spaces={[space(TEST_SPACE_ID, 'Hiring', { channelCount: streams.length })]}
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

    // Invoke the deadline the component actually armed. Sleeping from the
    // click races React committing the reveal effect under a loaded shard, so
    // its 2.2 seconds can end before the component's later 2-second timer.
    const revealTimer = await waitFor(() => {
      const timer = revealTimers.mock.calls.find(([, delay]) => delay === REVEAL_DEADLINE_MS)?.[0];
      expect(timer).toEqual(expect.any(Function));
      return timer;
    });
    act(() => {
      if (typeof revealTimer === 'function') revealTimer();
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
          throw new Error('The channel could not be reached.');
        }),
      },
    );
    // Opening on the filter brings its pill into view; only the row is at issue.
    scrollIntoView.mockClear();

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));

    // The row never moved, so following it somewhere would be following it
    // nowhere — on top of the dialog already explaining what happened.
    await screen.findByRole('dialog', { name: 'Channel could not be pinned' });
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

    const dialog = await screen.findByRole('dialog', { name: 'Pinned channels could not be reordered' });
    expect(within(dialog).getByText('The pinned list is back in the order it was in. Try again in a moment.'))
      .toBeVisible();
    // The open dialog hides the sidebar from the accessibility tree, so the
    // order can only be read once it is dismissed.
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(pinnedRowTitles()).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Bravo')]);
  });

  it('reports a pin the server refused', async () => {
    renderWith(
      [workstream('ws-recent', 'Quarterly planning', 'completed')],
      {
        onPinWorkstream: vi.fn(async () => {
          throw new Error('The channel could not be reached.');
        }),
      },
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));

    const dialog = await screen.findByRole('dialog', { name: 'Channel could not be pinned' });
    expect(within(dialog).getByText('The channel is still in the recent list. Try again in a moment.')).toBeVisible();
    expect(dialog).not.toHaveTextContent('The channel could not be reached.');
  });
});

describe('Sidebar channel paging', () => {
  beforeEach(() => {
    window.localStorage.clear();
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true };
    applicationSettings.listeners.clear();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300, sidebarSpaceFilter: null });
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

  it('opens organization search without loading sidebar pages', () => {
    const onOpenSearch = vi.fn();
    const onLoadMoreWorkstreams = vi.fn();
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions}
      onSignOut={vi.fn()} workspace={workspace} workstreams={[]} hasMoreWorkstreams
      onOpenSearch={onOpenSearch} onLoadMoreWorkstreams={onLoadMoreWorkstreams} /></Tooltip.Provider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Search organization' }));
    expect(onOpenSearch).toHaveBeenCalledOnce();
    expect(onLoadMoreWorkstreams).not.toHaveBeenCalled();
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

/**
 * Every Channel belongs to a Space, so a member's sidebar says where each one
 * lives rather than listing them all again by time. The guest shell has no
 * hierarchy to say it with and keeps the flat list.
 */
describe('the sidebar without a recency list', () => {
  beforeEach(() => {
    window.localStorage.clear();
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true };
    applicationSettings.listeners.clear();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300, sidebarSpaceFilter: null });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  it('continues paging until the selected Space has all of its Channels', () => {
    const hiring = space(undefined, undefined, { channelCount: 2 });
    const member = placedIn(workstream('first-space-page', 'First page', 'completed'), hiring.id);
    const onLoadMoreWorkstreams = vi.fn();
    useUiStore.setState({ sidebarSpaceFilter: hiring.id });
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} hasMoreWorkstreams
            onLoadMoreWorkstreams={onLoadMoreWorkstreams} onSignOut={vi.fn()} spaces={[hiring]}
            workspace={workspace} workstreams={[member]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(onLoadMoreWorkstreams).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function renderSidebar(props: Partial<React.ComponentProps<typeof Sidebar>>): void {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
            {...props}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
  }

  const today = workstream('ws-today', 'Roadmap review', 'completed', '2026-08-01T09:00:00.000Z');

  it('given a member session, when the sidebar is drawn, then no time-grouped list is', () => {
    const hiring = space();
    renderSidebar({ spaces: [hiring], workstreams: [placedIn(today, hiring.id)] });

    expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /actions$/u })).not.toBeInTheDocument();
    // In the Channel rail for the selected Space, and nowhere else.
    expect(screen.getAllByRole('link', { name: /Roadmap review/u })).toHaveLength(1);
  });

  // The guest shell is handed no Space directory at all — Space discovery is
  // deferred for a guest, and the host decides that rather than the component
  // inferring it. Absent is not empty, so this is the one session that keeps
  // the flat list.
  it('given a guest shell, when the sidebar is drawn, then the time-grouped list is untouched', () => {
    // The group a row lands in is read off the clock, so the clock is held.
    vi.useFakeTimers({ now: new Date('2026-08-01T12:00:00.000Z'), toFake: ['Date'] });
    renderSidebar({ workstreams: [today] });

    expect(screen.getByRole('heading', { name: 'Today' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Today actions' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Roadmap review/u })).toBeVisible();
    for (const launcher of screen.getAllByRole('button', { name: 'New channel' })) expect(launcher).toBeDisabled();
  });

  it('given a channel in no visible space, then a Space filter leaves it out and All shows it', () => {
    const hiring = space();
    const placed = placedIn(today, hiring.id);
    // Readable, and every one of its Spaces is somebody else's personal one:
    // **Manage access** already draws such a placement as a Space the viewer
    // cannot see, and without this section the Channel would be in the
    // sidebar nowhere at all.
    const elsewhere = placedIn(
      workstream('ws-elsewhere', 'Quarterly planning', 'completed'),
      '00000000-0000-7000-8000-0000000000ff',
    );
    useUiStore.setState({ sidebarSpaceFilter: hiring.id });
    renderSidebar({ spaces: [hiring], workstreams: [placed, elsewhere] });

    expect(screen.getByRole('link', { name: /Roadmap review/u })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Quarterly planning/u })).not.toBeInTheDocument();

    // All is every Channel the reader holds, wherever it is placed.
    selectSpace('All');
    expect(screen.getByRole('link', { name: /Quarterly planning/u })).toBeVisible();
  });

  it('given every channel placed where the reader can see it, then there is no Other channels section', () => {
    const hiring = space();
    renderSidebar({ spaces: [hiring], workstreams: [placedIn(today, hiring.id)] });

    expect(screen.queryByRole('region', { name: 'Other channels' })).not.toBeInTheDocument();
    expect(screen.queryByText('Other channels')).not.toBeInTheDocument();
  });

  /**
   * The state the removed list was the only thing describing.
   *
   * A member of a brand-new Organization sees Spaces, General, and "No
   * channels" under it — and then, without this line, nothing: a sidebar that
   * has stopped talking rather than one that is empty.
   */
  it('given a member with no channels at all, when the sidebar is drawn, then it says so', () => {
    renderSidebar({ spaces: [space()], workstreams: [] });

    expect(screen.getByText('No channels yet')).toBeVisible();
  });

  it('given Channels loaded a Space at a time, when the Space on screen has not answered, then it waits rather than saying it is empty', () => {
    const hiring = space();
    const onViewSpace = vi.fn();
    useUiStore.setState({ sidebarSpaceFilter: hiring.id });
    renderSidebar({ spaces: [hiring], workstreams: [], loadedSpaceIds: new Set(), onViewSpace });

    expect(onViewSpace).toHaveBeenLastCalledWith(hiring.id);
    expect(screen.queryByText('No channels yet')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading your spaces and channels');

    cleanup();
    renderSidebar({ spaces: [hiring], workstreams: [], loadedSpaceIds: new Set([hiring.id]), onViewSpace });
    expect(screen.getByText('No channels yet')).toBeVisible();
  });

  it('given a channel being created in the selected Space, then it shows dimmed and inert in place of the empty line', () => {
    const hiring = space();
    const launching = { ...placedIn(workstream('ws-launch', 'Launch plan', 'running'), hiring.id), pending: true as const };
    const elsewhere = { ...placedIn(workstream('ws-else', 'Elsewhere', 'running'), '00000000-0000-7000-8000-0000000000ff'), pending: true as const };
    useUiStore.setState({ sidebarSpaceFilter: hiring.id });
    renderSidebar({ spaces: [hiring], workstreams: [launching, elsewhere] });

    const row = screen.getByLabelText('Creating Launch plan');
    expect(row).toHaveClass('workstream-row', 'is-pending');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    // Nothing to open yet: the Channel has no screen until its create answers.
    expect(screen.queryByRole('link', { name: /Launch plan/u })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Creating Elsewhere')).not.toBeInTheDocument();
    expect(screen.queryByText('No channels yet')).not.toBeInTheDocument();
  });

  it('given a member with a channel, when the sidebar is drawn, then it does not claim to be empty', () => {
    const hiring = space();
    renderSidebar({ spaces: [hiring], workstreams: [placedIn(today, hiring.id)] });

    expect(screen.queryByText('No channels yet')).not.toBeInTheDocument();
  });

  /**
   * The one-time cutover, with the desktop open.
   *
   * The Spaces section draws its opening card *instead of* the rows until the
   * Organization has finished placing every Channel in General, and the
   * directory already carries General while that is going on. A fallback list
   * that read the directory without reading readiness would take each page of
   * placed Channels out of **Other channels** as the walk placed it, and put it
   * into a hierarchy nobody can see yet — a sidebar that empties itself, one
   * page at a time, for as long as the cutover runs.
   */
  it('given an organization still opening, when the sidebar is drawn, then every channel is still reachable', () => {
    const general = space('00000000-0000-7000-8000-0000000000f0', 'General');
    const placed = placedIn(today, general.id);
    renderSidebar({ spaces: [general], spacesReady: false, workstreams: [placed] });

    // The Space rail shows only its opening card, while the adjacent Channel
    // rail remains the temporary route to every Channel.
    expect(screen.queryByRole('link', { name: 'General' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Roadmap review/u })).toBeVisible();
    // Nowhere to create one yet: the server would refuse it until opening ends.
    expect(screen.getByRole('button', { name: 'New channel' })).toBeDisabled();
  });

  // The section above already holds it, and a row in both would take its order
  // from whichever the reader saw last — the same rule the list this replaces
  // was under.
  it('given an impossible unplaced pinned channel after opening, then it is not mixed into the selected Space', () => {
    const hiring = space();
    const unplaced = { ...pinned(workstream('ws-pinned', 'Launch tracking', 'completed'), 0), spaceIds: [] };
    useUiStore.setState({ sidebarSpaceFilter: hiring.id });
    renderSidebar({ spaces: [hiring], workstreams: [unplaced] });

    expect(screen.queryByRole('link', { name: /Launch tracking/u })).not.toBeInTheDocument();
  });
});

describe('alphabetical channels inside a space', () => {
  beforeEach(() => {
    window.localStorage.clear();
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true };
    applicationSettings.listeners.clear();
    // Every case here is about the list under one Space, so that Space is
    // the filter the sidebar opens on.
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300, sidebarSpaceFilter: hiring.id });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const hiring = space();
  const launch = space('00000000-0000-7000-8000-0000000000f3', 'Launch');
  const alpha = placedIn(workstream('ws-alpha', 'Alpha', 'completed', '2026-08-02T09:00:00.000Z'), hiring.id);
  const bravo = placedIn(workstream('ws-bravo', 'Bravo', 'completed', '2026-08-01T09:00:00.000Z'), hiring.id);

  /**
   * jsdom implements no `DataTransfer`, and this drag needs two of its fields:
   * `types`, which is how a Space row tells a Channel's drag from its own, and
   * `dropEffect`, which is how `dragend` tells a release the list took from one
   * backed out of.
   */
  function channelTransfer(dropEffect: 'move' | 'none' = 'move'): {
    dropEffect: string; effectAllowed: string; types: string[];
    setData: (type: string, value: string) => void; getData: (type: string) => string;
  } {
    const data = new Map<string, string>();
    const transfer = {
      dropEffect,
      effectAllowed: '',
      types: [] as string[],
      setData: (type: string, value: string) => {
        data.set(type, value);
        if (!transfer.types.includes(type)) transfer.types.push(type);
      },
      getData: (type: string) => data.get(type) ?? '',
    };
    return transfer;
  }

  function renderSidebar(props: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            spaces={[hiring, launch]}
            workspace={workspace}
            workstreams={[alpha, bravo]}
            {...props}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
  }

  function renderSidebarAt(
    workstreamId: string,
    rows: WorkstreamSummary[],
    props: Partial<React.ComponentProps<typeof Sidebar>> = {},
    initialEntries = [`/workstreams/${workstreamId}`],
  ): void {
    function RouteProbe(): React.JSX.Element {
      const probeLocation = useLocation();
      const probeNavigate = useNavigate();
      return <>
        <output aria-label="Current route">
          {probeLocation.pathname}{probeLocation.search}{probeLocation.hash}
        </output>
        <button type="button" onClick={() => void probeNavigate(-1)}>Test back</button>
        <button
          type="button"
          onClick={() => void probeNavigate(`${probeLocation.pathname}?panel=details#note`, { replace: true })}
        >Test query change</button>
      </>;
    }
    render(
      <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onMoveChannelToSpace={async () => undefined}
            onSignOut={vi.fn()}
            spaces={[hiring, launch]}
            workspace={workspace}
            workstreams={rows}
            {...props}
          />
          <RouteProbe />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
  }

  function placementTitles(): string[] {
    const list = document.querySelector(`:not(section)[data-motion-scope="space:${hiring.id}"]`);
    if (!list) throw new Error('The space has no placement list');
    return within(list as HTMLElement).getAllByRole('link')
      .map((row) => row.querySelector('.sidebar-row-title-copy')?.textContent ?? '');
  }

  function dragTarget(name: RegExp): HTMLElement {
    const wrapper = screen.getByRole('link', { name }).parentElement?.closest('.sidebar-context-target');
    if (!wrapper) throw new Error('The channel row has no drag wrapper');
    return wrapper as HTMLElement;
  }

  it('sorts unpinned channels case-insensitively with a fixed locale and stable ties', () => {
    const lowercase = placedIn(workstream('ws-lowercase', 'alpha', 'completed'), hiring.id);
    const uppercase = placedIn(workstream('ws-uppercase', 'Alpha', 'completed'), hiring.id);
    const accented = placedIn(workstream('ws-accented', 'Åland', 'completed'), hiring.id);
    const duplicateLater = placedIn(workstream('ws-duplicate-z', 'Same', 'completed'), hiring.id);
    const duplicateEarlier = placedIn(workstream('ws-duplicate-a', 'Same', 'completed'), hiring.id);
    const zulu = placedIn(workstream('ws-zulu', 'Zulu', 'completed'), hiring.id);
    renderSidebar({
      workstreams: [zulu, duplicateLater, duplicateEarlier, uppercase, bravo, lowercase, accented],
    });

    expect(placementTitles()).toEqual(['Åland', 'alpha', 'Alpha', 'Bravo', 'Same', 'Same', 'Zulu']);
    const list = document.querySelector(`:not(section)[data-motion-scope="space:${hiring.id}"]`);
    expect([...list?.querySelectorAll<HTMLElement>('[data-workstream-id]') ?? []]
      .map((row) => row.dataset.workstreamId)).toEqual([
      accented.id,
      lowercase.id,
      uppercase.id,
      bravo.id,
      duplicateEarlier.id,
      duplicateLater.id,
      zulu.id,
    ]);
  });

  // A Channel can still move between Spaces; it just cannot be manually
  // reordered inside the alphabetical list it is leaving.
  it('given a placement dropped on another space, then it is moved and nothing is reordered', async () => {
    const onMoveChannelToSpace = vi.fn(async () => undefined);
    renderSidebar({ onMoveChannelToSpace });

    const transfer = channelTransfer();
    const target = pill('Launch');
    fireEvent.dragStart(dragTarget(/Bravo/u), { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    fireEvent.dragEnd(dragTarget(/Bravo/u), { dataTransfer: transfer });

    await waitFor(() => expect(onMoveChannelToSpace).toHaveBeenCalledWith(hiring.id, launch.id, bravo.id));
    expect(placementTitles()).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Bravo')]);
  });

  it('opens the next Channel down when the current Channel is moved out of the selected Space', async () => {
    renderSidebarAt(alpha.id, [alpha, bravo]);
    const transfer = channelTransfer();

    fireEvent.dragStart(dragTarget(/Alpha/u), { dataTransfer: transfer });
    fireEvent.drop(pill('Launch'), { dataTransfer: transfer });

    await waitFor(() => expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/workstreams/${bravo.id}`));
  });

  it('opens the Channel above when the current Channel is moved from the bottom', async () => {
    renderSidebarAt(bravo.id, [alpha, bravo]);
    const transfer = channelTransfer();

    fireEvent.dragStart(dragTarget(/Bravo/u), { dataTransfer: transfer });
    fireEvent.drop(pill('Launch'), { dataTransfer: transfer });

    await waitFor(() => expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/workstreams/${alpha.id}`));
  });

  it('opens the Space it left when the moved Channel was the selected Space\'s last one', async () => {
    renderSidebarAt(alpha.id, [alpha]);
    const transfer = channelTransfer();

    fireEvent.dragStart(dragTarget(/Alpha/u), { dataTransfer: transfer });
    fireEvent.drop(pill('Launch'), { dataTransfer: transfer });

    await waitFor(() => expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/spaces/${hiring.id}`));
  });

  it('restores the moved Channel route when the server refuses the move', async () => {
    let refuseMove: ((cause: Error) => void) | undefined;
    renderSidebarAt(alpha.id, [alpha, bravo], {
      onMoveChannelToSpace: () => new Promise<void>((_, reject) => {
        refuseMove = reject;
      }),
    }, [`/workstreams/${alpha.id}?panel=details#note`]);
    const transfer = channelTransfer();

    fireEvent.dragStart(dragTarget(/Alpha/u), { dataTransfer: transfer });
    fireEvent.drop(pill('Launch'), { dataTransfer: transfer });
    await waitFor(() => expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/workstreams/${bravo.id}`));

    await act(async () => refuseMove?.(new Error('space_access_denied')));
    await waitFor(() => expect(document.querySelector('output[aria-label="Current route"]'))
      .toHaveTextContent(`/workstreams/${alpha.id}?panel=details#note`));
  });

  it('does not overwrite a newer query or hash when the move is refused', async () => {
    let refuseMove: ((cause: Error) => void) | undefined;
    renderSidebarAt(alpha.id, [alpha, bravo], {
      onMoveChannelToSpace: () => new Promise<void>((_, reject) => {
        refuseMove = reject;
      }),
    });
    const transfer = channelTransfer();

    fireEvent.dragStart(dragTarget(/Alpha/u), { dataTransfer: transfer });
    fireEvent.drop(pill('Launch'), { dataTransfer: transfer });
    await waitFor(() => expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/workstreams/${bravo.id}`));
    fireEvent.click(screen.getByRole('button', { name: 'Test query change' }));
    expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/workstreams/${bravo.id}?panel=details#note`);

    await act(async () => refuseMove?.(new Error('space_access_denied')));
    expect(document.querySelector('output[aria-label="Current route"]'))
      .toHaveTextContent(`/workstreams/${bravo.id}?panel=details#note`);
  });

  it('waits for an unloaded lower Channel instead of opening Channel home', async () => {
    let revealNext: (() => void) | undefined;
    function Harness(): React.JSX.Element {
      const [rows, setRows] = useState<WorkstreamSummary[]>([alpha]);
      revealNext = () => setRows([bravo]);
      return <Sidebar
        {...defaultActions}
        loadingMoreWorkstreams
        onMoveChannelToSpace={async () => undefined}
        onSignOut={vi.fn()}
        spaces={[{ ...hiring, channelCount: 2 }, launch]}
        workspace={workspace}
        workstreams={rows}
      />;
    }
    function RouteProbe(): React.JSX.Element {
      return <output aria-label="Current route">{useLocation().pathname}</output>;
    }
    render(
      <MemoryRouter initialEntries={[`/workstreams/${alpha.id}`]}>
        <Tooltip.Provider>
          <Harness />
          <RouteProbe />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
    const transfer = channelTransfer();

    fireEvent.dragStart(dragTarget(/Alpha/u), { dataTransfer: transfer });
    fireEvent.drop(pill('Launch'), { dataTransfer: transfer });
    expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/workstreams/${alpha.id}`);

    act(() => revealNext?.());
    await waitFor(() => expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/workstreams/${bravo.id}`));
  });

  it('replaces the moved Channel in history', async () => {
    renderSidebarAt(
      alpha.id,
      [alpha, bravo],
      {},
      [`/spaces/${hiring.id}`, `/workstreams/${alpha.id}`],
    );
    const transfer = channelTransfer();

    fireEvent.dragStart(dragTarget(/Alpha/u), { dataTransfer: transfer });
    fireEvent.drop(pill('Launch'), { dataTransfer: transfer });
    await waitFor(() => expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/workstreams/${bravo.id}`));
    fireEvent.click(screen.getByRole('button', { name: 'Test back' }));

    await waitFor(() => expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/spaces/${hiring.id}`));
  });

  it('does not advertise a cross-space move from a read-only source Space', () => {
    const readOnly = { ...hiring, reach: 'through_channel' as const };
    renderSidebar({
      spaces: [readOnly, launch],
      workstreams: [placedIn(alpha, readOnly.id)],
    });
    const transfer = channelTransfer('none');

    fireEvent.dragStart(dragTarget(/Alpha/u), { dataTransfer: transfer });

    expect(transfer.types).toContain('application/x-rally-workstream-id');
    expect(transfer.types).not.toContain('application/x-rally-channel-source-space-id');
  });

  it('abandons a pinned reorder preview when the Channel is dropped on another Space', async () => {
    const onMoveChannelToSpace = vi.fn(async () => undefined);
    const onReorderPinnedWorkstreams = vi.fn(async () => undefined);
    renderSidebar({
      onMoveChannelToSpace,
      onReorderPinnedWorkstreams,
      workstreams: [pinned(alpha, 0), pinned(bravo, 1)],
    });
    const transfer = channelTransfer();
    const pinnedTitles = (): string[] => within(screen.getByRole('region', { name: 'Pinned' }))
      .getAllByRole('link').map((row) => row.textContent ?? '');

    fireEvent.dragStart(dragTarget(/Bravo/u), { dataTransfer: transfer });
    fireEvent.dragOver(dragTarget(/Alpha/u), { dataTransfer: transfer });
    expect(pinnedTitles()).toEqual([expect.stringContaining('Bravo'), expect.stringContaining('Alpha')]);
    fireEvent.drop(pill('Launch'), { dataTransfer: transfer });
    fireEvent.dragEnd(dragTarget(/Bravo/u), { dataTransfer: transfer });

    await waitFor(() => expect(onMoveChannelToSpace).toHaveBeenCalledWith(hiring.id, launch.id, bravo.id));
    expect(onReorderPinnedWorkstreams).not.toHaveBeenCalled();
    await waitFor(() => expect(pinnedTitles())
      .toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Bravo')]));
  });

  it('does not reorder the alphabetical section with Alt+Arrow', () => {
    renderSidebar();

    fireEvent.keyDown(dragTarget(/Bravo/u), { altKey: true, key: 'ArrowUp' });

    expect(placementTitles()).toEqual(['Alpha', 'Bravo']);
  });

  it('wakes the empty Pinned drop zone for a channel drag and pins the dropped channel', async () => {
    const onPinWorkstream = vi.fn(async () => true);
    renderSidebar({ onPinWorkstream, workstreams: [alpha, bravo] });
    const transfer = channelTransfer();
    const source = dragTarget(/Bravo/u);

    const pinnedTarget = screen.getByRole('region', { name: 'Pinned' });
    const zone = within(pinnedTarget).getByText('Move a channel here to pin it').parentElement!;
    expect(zone).not.toHaveClass('is-armed');
    fireEvent.dragStart(source, { dataTransfer: transfer });
    expect(transfer.getData('application/x-rally-workstream-id')).toBe(bravo.id);
    expect(zone).toHaveClass('is-armed');
    fireEvent.dragOver(pinnedTarget, { dataTransfer: transfer });
    fireEvent.drop(pinnedTarget, { dataTransfer: transfer });
    fireEvent.dragEnd(source, { dataTransfer: transfer });

    await waitFor(() => expect(onPinWorkstream).toHaveBeenCalledWith(bravo, hiring.id, true));
  });

  it('settles the empty Pinned drop zone when the Channel drag is cancelled', () => {
    renderSidebar({ workstreams: [alpha, bravo] });
    const transfer = channelTransfer('none');
    const source = dragTarget(/Bravo/u);
    const zone = screen.getByText('Move a channel here to pin it').parentElement!;

    fireEvent.dragStart(source, { dataTransfer: transfer });
    expect(zone).toHaveClass('is-armed');

    fireEvent.dragEnd(source, { dataTransfer: transfer });

    expect(zone).not.toHaveClass('is-armed');
    expect(screen.getByRole('region', { name: 'Pinned' })).toContainElement(zone);
  });

  it('offers placement removal for a pinned Channel in the selected Space', async () => {
    const onRemoveChannelFromSpace = vi.fn(async () => undefined);
    renderSidebar({
      onRemoveChannelFromSpace,
      workstreams: [pinned(alpha, 0), bravo],
    });

    fireEvent.contextMenu(screen.getByRole('link', { name: /Alpha/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from space' }));

    await waitFor(() => expect(onRemoveChannelFromSpace).toHaveBeenCalledWith(hiring.id, alpha.id));
  });

});

describe('the sidebar Space filter', () => {
  const home = general();
  const hiring = space();
  const launch = space('00000000-0000-7000-8000-0000000000f5', 'Launch');
  const alpha = placedIn(workstream('ws-alpha', 'Alpha', 'completed'), home.id);
  const bravo = placedIn(workstream('ws-bravo', 'Bravo', 'completed'), home.id, hiring.id);
  const charlie = placedIn(workstream('ws-charlie', 'Charlie', 'completed'), hiring.id, launch.id);
  const delta = placedIn(workstream('ws-delta', 'Delta', 'completed'), launch.id);
  const openBrowserImport = vi.fn(async () => undefined);

  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300, sidebarSpaceFilter: null });
    updateStatus.current = { kind: 'idle' };
    installDownloadedUpdate.mockClear();
    openBrowserImport.mockClear();
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function renderFiltered(props: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            onSignOut={vi.fn()}
            spaces={[home, hiring, launch]}
            workspace={workspace}
            workstreams={[alpha, bravo, charlie, delta]}
            {...props}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
  }

  /** The Channel rows on screen, by title, in the order they are drawn. */
  function channelTitles(): string[] {
    return [...screen.getByRole('navigation', { name: 'Channels' }).querySelectorAll('[data-workstream-id] .sidebar-row-title-copy')]
      .map((title) => title.textContent ?? '');
  }

  /** The titles in the Pinned section, in order. */
  function pinnedTitles(): string[] {
    return [...screen.getByRole('region', { name: 'Pinned' }).querySelectorAll('.sidebar-row-title-copy')]
      .map((title) => title.textContent ?? '');
  }

  it('lists every Channel under All and only the selected Space\'s under its pill', () => {
    renderFiltered();

    expect(pill('All')).toHaveAttribute('aria-pressed', 'true');
    expect(channelTitles()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);

    selectSpace('Hiring');
    expect(pill('Hiring')).toHaveAttribute('aria-pressed', 'true');
    expect(channelTitles()).toEqual(['Bravo', 'Charlie']);
    expect(useUiStore.getState().sidebarSpaceFilter).toBe(hiring.id);

    selectSpace('Launch');
    expect(channelTitles()).toEqual(['Charlie', 'Delta']);

    selectSpace('All');
    expect(channelTitles()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(useUiStore.getState().sidebarSpaceFilter).toBeNull();
  });

  it('draws no General pill, and a stored General filter reads as All', () => {
    useUiStore.setState({ sidebarSpaceFilter: home.id });
    renderFiltered();

    expect(pillNames()).toEqual(['All', 'Hiring', 'Launch']);
    expect(pill('All')).toHaveAttribute('aria-pressed', 'true');
    expect(channelTitles()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('names a Channel\'s Spaces under its title, leaving General out', () => {
    renderFiltered();

    const subtitle = (title: string): string | null => screen.getByRole('link', { name: title })
      .querySelector('.channel-row-subtitle')?.textContent ?? null;
    expect(subtitle('Alpha')).toBeNull();
    expect(within(screen.getByRole('link', { name: 'Alpha' })).queryByText(/General/u)).not.toBeInTheDocument();
    expect(subtitle('Bravo')).toBe('Hiring');
    expect(subtitle('Charlie')).toBe('Hiring, Launch');
    expect(subtitle('Delta')).toBe('Launch');
  });

  it('marks a Channel whose only news is in a Breakout as unread', () => {
    renderFiltered({ workstreams: [{ ...alpha, breakoutAttentionCount: 1 }, bravo] });

    expect(markerOf('Alpha')).toBe('Unread');
    expect(screen.getByRole('link', { name: 'Alpha, 1 conversation needs attention' })).toBeInTheDocument();
    expect(markerOf('Bravo')).toBeNull();
  });

  it('shows every pin under All, General\'s run first and the rest after', () => {
    renderFiltered({
      workstreams: [
        { ...alpha, spacePins: [{ spaceId: home.id, position: 1 }] },
        { ...bravo, spacePins: [{ spaceId: home.id, position: 0 }] },
        { ...charlie, spacePins: [{ spaceId: launch.id, position: 0 }] },
        delta,
      ],
    });

    expect(pinnedTitles()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(channelTitles().slice(3)).toEqual(['Delta']);

    selectSpace('Launch');
    expect(pinnedTitles()).toEqual(['Charlie']);
  });

  it('pins under All in General when the Channel lives there, and in its first Space otherwise', async () => {
    const onPinWorkstream = vi.fn(async () => true);
    renderFiltered({ onPinWorkstream });

    fireEvent.contextMenu(screen.getByRole('link', { name: 'Bravo' }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(onPinWorkstream).toHaveBeenLastCalledWith(expect.objectContaining({ id: bravo.id }), home.id, true));

    fireEvent.contextMenu(screen.getByRole('link', { name: 'Charlie' }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(onPinWorkstream).toHaveBeenLastCalledWith(expect.objectContaining({ id: charlie.id }), hiring.id, true));
    expect(onPinWorkstream).toHaveBeenCalledTimes(2);
  });

  it('unpins under All from every Space that pins the Channel', async () => {
    const onPinWorkstream = vi.fn<(target: WorkstreamSummary, spaceId: string, pinned: boolean) => Promise<boolean>>(async () => true);
    renderFiltered({
      onPinWorkstream,
      workstreams: [{ ...charlie, spacePins: [{ spaceId: hiring.id, position: 0 }, { spaceId: launch.id, position: 3 }] }],
    });

    fireEvent.contextMenu(screen.getByRole('link', { name: /^Charlie/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));

    await waitFor(() => expect(onPinWorkstream).toHaveBeenCalledTimes(2));
    expect(onPinWorkstream.mock.calls.map(([, spaceId, pinned]) => [spaceId, pinned]))
      .toEqual([[hiring.id, false], [launch.id, false]]);
  });

  it('reorders All\'s pins as General\'s run while every pin is General\'s', async () => {
    const onReorderPinnedWorkstreams = vi.fn(async () => undefined);
    renderFiltered({
      onReorderPinnedWorkstreams,
      workstreams: [
        { ...alpha, spacePins: [{ spaceId: home.id, position: 0 }] },
        { ...bravo, spacePins: [{ spaceId: home.id, position: 1 }] },
      ],
    });

    fireEvent.keyDown(screen.getByRole('link', { name: /^Bravo/u }), { key: 'ArrowUp', altKey: true });

    await waitFor(() => expect(onReorderPinnedWorkstreams).toHaveBeenCalledWith(home.id, [bravo.id, alpha.id]));
  });

  it('does not reorder All\'s pins once one belongs to another Space', () => {
    const onReorderPinnedWorkstreams = vi.fn(async () => undefined);
    renderFiltered({
      onReorderPinnedWorkstreams,
      workstreams: [
        { ...alpha, spacePins: [{ spaceId: home.id, position: 0 }] },
        { ...charlie, spacePins: [{ spaceId: launch.id, position: 0 }] },
      ],
    });

    fireEvent.keyDown(screen.getByRole('link', { name: /^Charlie/u }), { key: 'ArrowUp', altKey: true });

    expect(onReorderPinnedWorkstreams).not.toHaveBeenCalled();
    expect(pinnedTitles()).toEqual(['Alpha', 'Charlie']);
  });

  it('draws All\'s pins in the person\'s own order, and Alt+Arrow saves it whole across Spaces', async () => {
    const onReorderAllPinned = vi.fn(async () => undefined);
    const onReorderPinnedWorkstreams = vi.fn(async () => undefined);
    renderFiltered({
      allPinnedOrder: [charlie.id, alpha.id],
      onReorderAllPinned,
      onReorderPinnedWorkstreams,
      workstreams: [
        { ...alpha, spacePins: [{ spaceId: home.id, position: 0 }] },
        { ...bravo, spacePins: [{ spaceId: home.id, position: 1 }] },
        { ...charlie, spacePins: [{ spaceId: launch.id, position: 0 }] },
      ],
    });

    // Named ids first in the person's order; Bravo, never ordered, follows.
    expect(pinnedTitles()).toEqual(['Charlie', 'Alpha', 'Bravo']);

    fireEvent.keyDown(screen.getByRole('link', { name: /^Bravo/u }), { key: 'ArrowUp', altKey: true });

    await waitFor(() => expect(onReorderAllPinned).toHaveBeenCalledWith([charlie.id, bravo.id, alpha.id]));
    expect(onReorderPinnedWorkstreams).not.toHaveBeenCalled();
  });

  it('pins a Channel dropped on the Pinned section under All', async () => {
    const onPinWorkstream = vi.fn(async () => true);
    renderFiltered({ onPinWorkstream, onReorderAllPinned: vi.fn(async () => undefined) });
    // jsdom has no DataTransfer; the row reads and writes only these.
    const data = new Map<string, string>();
    const transfer = {
      dropEffect: 'move',
      effectAllowed: '',
      types: [] as string[],
      setData: (type: string, value: string) => { data.set(type, value); transfer.types.push(type); },
      getData: (type: string) => data.get(type) ?? '',
    };
    const source = screen.getByRole('link', { name: 'Charlie' }).closest<HTMLElement>('.sidebar-context-target')!;

    fireEvent.dragStart(source, { dataTransfer: transfer });
    const pinnedSection = screen.getByRole('region', { name: 'Pinned' });
    fireEvent.dragOver(pinnedSection, { dataTransfer: transfer });
    fireEvent.drop(pinnedSection, { dataTransfer: transfer });
    fireEvent.dragEnd(source, { dataTransfer: transfer });

    await waitFor(() => expect(onPinWorkstream).toHaveBeenCalledWith(expect.objectContaining({ id: charlie.id }), hiring.id, true));
  });

  it('widens a Space filter to All when the open Channel is not in that Space', () => {
    useUiStore.setState({ sidebarSpaceFilter: launch.id });
    render(
      <MemoryRouter initialEntries={[`/workstreams/${alpha.id}`]}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} onSignOut={vi.fn()} spaces={[home, hiring, launch]}
            workspace={workspace} workstreams={[alpha, bravo, charlie, delta]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(pill('All')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: 'Alpha' })).toHaveClass('is-active');
  });

  describe('the header', () => {
    it('opens organization search', () => {
      const onOpenSearch = vi.fn();
      renderFiltered({ onOpenSearch });

      fireEvent.click(screen.getByRole('button', { name: 'Search organization' }));
      expect(onOpenSearch).toHaveBeenCalledOnce();
    });

    it('imports into any writable Space under All, and only the selected one under its pill', () => {
      vi.stubGlobal('rally', { openBrowserImport });
      const reached = space('00000000-0000-7000-8000-0000000000f4', 'Theirs', { reach: 'through_channel', participants: [] });
      renderFiltered({ spaces: [home, hiring, launch, reached] });

      fireEvent.click(screen.getByRole('button', { name: 'Import from ChatGPT or Claude' }));
      expect(openBrowserImport).toHaveBeenLastCalledWith({
        spaces: [
          { id: home.id, name: 'General' },
          { id: hiring.id, name: 'Hiring' },
          { id: launch.id, name: 'Launch' },
        ],
      });

      selectSpace('Hiring');
      fireEvent.click(screen.getByRole('button', { name: 'Import from ChatGPT or Claude' }));
      expect(openBrowserImport).toHaveBeenLastCalledWith({
        spaces: [{ id: hiring.id, name: 'Hiring' }],
        spaceLocked: true,
      });
    });

    it('offers no import outside the desktop host', () => {
      renderFiltered();

      expect(screen.queryByRole('button', { name: 'Import from ChatGPT or Claude' })).not.toBeInTheDocument();
    });

    it('offers a restart only once an update has been downloaded', async () => {
      updateStatus.current = { kind: 'downloaded', version: '2.4.0' };
      renderFiltered();

      fireEvent.click(await screen.findByRole('button', { name: 'Restart to update to Rally 2.4.0' }));
      expect(installDownloadedUpdate).toHaveBeenCalledOnce();
    });

    it('draws no restart while no update is ready', async () => {
      renderFiltered();
      await act(async () => undefined);

      expect(screen.queryByRole('button', { name: /Restart to update/u })).not.toBeInTheDocument();
    });

    it('starts a channel in the selected Space from New channel', async () => {
      const onCreateChannel = vi.fn(async () => undefined);
      renderFiltered({ onCreateChannel });
      selectSpace('Launch');

      fireEvent.click(screen.getByRole('button', { name: 'New channel' }));
      const dialog = await screen.findByRole('dialog', { name: 'Start a new channel' });
      expect(within(dialog).getByRole('combobox', { name: 'Space' })).toHaveTextContent('Launch');
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Roadmap' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

      await waitFor(() => expect(onCreateChannel).toHaveBeenCalledWith({ name: 'Roadmap', spaceId: launch.id }));
    });
  });
});

describe('channelPinTargets', () => {
  const channel = { spaceIds: ['general', 'space-x'], spacePins: [{ spaceId: 'general', position: 0 }] };
  const active = new Set(['general', 'space-x']);

  it('unpins every Space that pins the Channel when asked as All, which is how its menu asks', () => {
    // Filtered to Space X while pinned only in General: the menu reads it as
    // pinned, so its unpin must clear General rather than write to X.
    expect(channelPinTargets(channel, false, { activeSpaceIds: active, generalSpaceId: 'general', selectedSpaceId: null }))
      .toEqual(['general']);
  });

  it('pins under a Space filter in that Space, and under All in General first', () => {
    const unpinned = { spaceIds: ['general', 'space-x'], spacePins: [] };
    expect(channelPinTargets(unpinned, true, { activeSpaceIds: active, generalSpaceId: 'general', selectedSpaceId: 'space-x' }))
      .toEqual(['space-x']);
    expect(channelPinTargets(unpinned, true, { activeSpaceIds: active, generalSpaceId: 'general', selectedSpaceId: null }))
      .toEqual(['general']);
  });
});

describe('allPinPosition', () => {
  const generalId = '00000000-0000-7000-8000-0000000000f0';

  it('is the General pin\'s position when General pins the Channel', () => {
    expect(allPinPosition({
      spaceIds: [generalId, TEST_SPACE_ID],
      spacePins: [{ spaceId: TEST_SPACE_ID, position: 0 }, { spaceId: generalId, position: 4 }],
    }, generalId)).toBe(4);
  });

  it('places a pin outside General after every General pin, by its lowest position', () => {
    const outside = allPinPosition({
      spaceIds: [TEST_SPACE_ID, 'space-b'],
      spacePins: [{ spaceId: TEST_SPACE_ID, position: 5 }, { spaceId: 'space-b', position: 2 }],
    }, generalId);
    const generalPin = allPinPosition({ spaceIds: [generalId], spacePins: [{ spaceId: generalId, position: 999 }] }, generalId);

    expect(outside).toBe(1_000_002);
    expect(generalPin).toBe(999);
    expect(generalPin!).toBeLessThan(outside!);
  });

  it('is null for a Channel pinned nowhere, or only in a Space it has left', () => {
    expect(allPinPosition({ spaceIds: [generalId], spacePins: [] }, generalId)).toBeNull();
    expect(allPinPosition({ spaceIds: [generalId] }, generalId)).toBeNull();
    expect(allPinPosition({
      spaceIds: [generalId],
      spacePins: [{ spaceId: TEST_SPACE_ID, position: 0 }],
    }, generalId)).toBeNull();
  });

  it('reads every pin as outside General when there is no General', () => {
    expect(allPinPosition({
      spaceIds: [TEST_SPACE_ID],
      spacePins: [{ spaceId: TEST_SPACE_ID, position: 3 }],
    }, null)).toBe(1_000_003);
  });
});
