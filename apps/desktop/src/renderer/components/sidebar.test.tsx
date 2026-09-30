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
import type { AutomationSummary, Workspace, WorkstreamSummary } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { installWindowActivationTracking } from '../lib/window-activation';
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
    useUiStore.setState({ sidebarOpen: false, sidebarCollapsed: false, sidebarWidth: 300 });
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
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions}
      automations={[]} onSignOut={vi.fn()} workspace={workspace}
      workstreams={[noisy, visited]} /></Tooltip.Provider></MemoryRouter>);
    const links = screen.getAllByRole('link').map((link) => link.textContent);
    expect(links.findIndex((text) => text?.includes('Last visited')))
      .toBeLessThan(links.findIndex((text) => text?.includes('New shared activity')));
  });

  it('keeps the unsent new channel out of the sidebar', () => {
    render(<MemoryRouter initialEntries={['/workstreams/new']}><Tooltip.Provider>
      <Sidebar {...defaultActions} conversationOnly automations={[]} onSignOut={vi.fn()}
        workspace={workspace} workstreams={[]} />
    </Tooltip.Provider></MemoryRouter>);

    expect(screen.queryByLabelText('New channel draft')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New channel' })).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('marks sidebar creation telemetry only when the Channel setup is submitted', async () => {
    const onCreateChannel = vi.fn(async () => undefined);
    render(<MemoryRouter><Tooltip.Provider>
      <Sidebar {...defaultActions} automations={[]} onCreateChannel={onCreateChannel}
        onSignOut={vi.fn()} spaces={[general()]} workspace={workspace} workstreams={[]} />
    </Tooltip.Provider></MemoryRouter>);
    const launcher = screen.getAllByRole('button', { name: 'New channel or space' })[0];
    if (!launcher) throw new Error('New channel launcher missing');
    fireEvent.keyDown(launcher, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start New Channel' }));
    expect(markSurfaceEntrypoint).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Start a new channel' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Launch' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreateChannel).toHaveBeenCalledWith({ name: 'Launch', spaceId: general().id }));
    expect(markSurfaceEntrypoint).toHaveBeenCalledWith('sidebar_new');
  });

  it('reduces the GrokBot shell navigation to channels', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[automation]}
            conversationOnly
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
    expect(screen.getByRole('button', { name: 'Search organization' })).toBeInTheDocument();
    const titlebar = document.querySelector('.sidebar-titlebar');
    const commandbar = document.querySelector('.sidebar-commandbar');
    expect(titlebar).not.toBeNull();
    expect(commandbar).not.toBeNull();
    expect(titlebar).toContainElement(screen.getByRole('button', { name: 'New channel' }));
    expect(commandbar).toContainElement(screen.getByRole('button', { name: 'Search organization' }));
    expect(commandbar?.querySelector('.sidebar-new-button')).toBeNull();
  });

  // The plus is the whole of this control in the titlebar and in the rail: an
  // icon with no words beside it, whose name a pointer can only read from a
  // tooltip. It is the link's own name as well, so both readers get the same
  // sentence, and it says work stream in the GrokBot shell too — that shell
  // presents a conversation as a chat, but the route this opens still starts a
  // work stream.
  it('names the plus New channel in the titlebar, the rail, and the GrokBot shell', () => {
    function Navigation(props: { compact?: boolean; conversationOnly?: boolean }) {
      return <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} {...props} />;
    }
    const { rerender } = render(<MemoryRouter><Tooltip.Provider><Navigation /></Tooltip.Provider></MemoryRouter>);

    const titlebar = document.querySelector('.sidebar-titlebar');
    expect(titlebar).not.toBeNull();
    const create = within(titlebar as HTMLElement).getByRole('button', { name: 'New channel' });
    // Both links are tooltip triggers, and Radix's Slot string-merges the
    // child's `className`: hand it `NavLink`'s callback form and the class
    // arrives at the DOM as that callback's source text, leaving the control
    // unstyled while every other assertion here still passes. Only a real
    // window shows that, and a window is not a gate the next change runs.
    expect(create).toHaveClass('sidebar-new-button');
    fireEvent.focus(create);
    expect(screen.getByRole('tooltip')).toHaveTextContent('New channel');

    rerender(<MemoryRouter><Tooltip.Provider><Navigation compact /></Tooltip.Provider></MemoryRouter>);
    const commandbar = document.querySelector('.sidebar-commandbar');
    expect(commandbar).not.toBeNull();
    const rail = within(commandbar as HTMLElement).getByRole('button', { name: 'New channel' });
    expect(rail).toHaveClass('sidebar-new-button', 'sidebar-rail-new-button');
    fireEvent.focus(rail);
    expect(screen.getByRole('tooltip')).toHaveTextContent('New channel');

    rerender(<MemoryRouter><Tooltip.Provider><Navigation conversationOnly /></Tooltip.Provider></MemoryRouter>);
    fireEvent.focus(screen.getByRole('button', { name: 'New channel' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('New channel');
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

  it('temporarily caps Spaces to the available hierarchy width without replacing its saved preference', () => {
    const hiring = space();
    useUiStore.getState().setSpacesSidebarWidth(400);
    const { container } = render(
      <div className="workspace-shell">
        <MemoryRouter>
          <Tooltip.Provider>
            <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} spaces={[hiring]}
              spacesAvailableWidth={300} workspace={workspace} workstreams={[]} />
          </Tooltip.Provider>
        </MemoryRouter>
      </div>,
    );

    expect(screen.getByRole('separator', { name: 'Resize spaces sidebar' })).toHaveAttribute('aria-valuenow', '300');
    expect(container.querySelector<HTMLElement>('.workspace-shell')?.style.getPropertyValue('--spaces-sidebar-width')).toBe('300px');
    expect(useUiStore.getState().spacesSidebarWidth).toBe(400);
  });

  it('preserves the expanded preference while navigation is forced compact', () => {
    useUiStore.getState().setSidebarCollapsed(false);
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} compact constrained conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    const toggle = screen.getByRole('button', { name: 'Expand channels' });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    const resizer = screen.getByRole('separator', { name: 'Resize navigation' });
    fireEvent.keyDown(resizer, { key: 'ArrowRight' });
    fireEvent.doubleClick(resizer);
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    expect(useUiStore.getState().sidebarWidth).toBe(300);
    expect(localStorage.getItem('rally.sidebar-collapsed')).toBe('false');
  });

  it('toggles the saved navigation preference from the footer and right edge', () => {
    useUiStore.getState().setSidebarCollapsed(false);
    function Navigation() {
      const compact = useUiStore((state) => state.sidebarCollapsed);
      return <Sidebar {...defaultActions} compact={compact} conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />;
    }
    render(<MemoryRouter><Tooltip.Provider><Navigation /></Tooltip.Provider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse channels' }));
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Expand channels' }));
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    const edge = screen.getByRole('separator', { name: 'Resize navigation' });
    fireEvent.doubleClick(edge);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    fireEvent.doubleClick(edge);
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  // The divider is the only control in the sidebar with no words on it, and the
  // double-click that collapses it has been reachable only by guessing. The
  // hint is where both are written down, so which of collapse and expand it
  // names has to follow the state the next double-click would leave behind.
  it('names the drag and the double-click on the divider, in the direction the next one goes', () => {
    useUiStore.getState().setSidebarCollapsed(false);
    function Navigation() {
      const compact = useUiStore((state) => state.sidebarCollapsed);
      return <Sidebar {...defaultActions} compact={compact} conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />;
    }
    render(<MemoryRouter><Tooltip.Provider><Navigation /></Tooltip.Provider></MemoryRouter>);
    const edge = screen.getByRole('separator', { name: 'Resize navigation' });
    expect(edge.querySelector('svg')).toHaveAttribute('width', '11');
    expect(edge.querySelector('svg')).toHaveAttribute('height', '11');
    expect(edge.querySelector('svg')).toHaveAttribute('stroke-width', '2');

    fireEvent.focus(edge);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Drag to resize');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Double-click or Enter to collapse');

    fireEvent.doubleClick(edge);
    fireEvent.blur(edge);
    fireEvent.focus(edge);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Double-click or Enter to expand');
  });

  // The hint is read on focus as well as on hover, so the reader most likely to
  // be looking at it is the one who cannot double-click. Enter is the ARIA
  // authoring practices' key for a splitter's own action, and it has to do what
  // the same handle's double-click does, under the same guard.
  it('collapses and expands from Enter on the divider, and refuses it while the window holds navigation compact', () => {
    useUiStore.getState().setSidebarCollapsed(false);
    function Navigation() {
      const compact = useUiStore((state) => state.sidebarCollapsed);
      return <Sidebar {...defaultActions} compact={compact} conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />;
    }
    const view = render(<MemoryRouter><Tooltip.Provider><Navigation /></Tooltip.Provider></MemoryRouter>);
    const edge = screen.getByRole('separator', { name: 'Resize navigation' });

    fireEvent.keyDown(edge, { key: 'Enter' });
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    fireEvent.keyDown(edge, { key: 'Enter' });
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);

    view.unmount();
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} compact constrained conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize navigation' }), { key: 'Enter' });
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  // `compact` is `collapsed || constrained`, so it cannot say which of the two
  // is holding the sidebar in the rail. Somebody who collapsed navigation and
  // then narrowed the window is held by both, and expanding is impossible: the
  // hint must not offer it, and the toggle must not quietly rewrite the saved
  // preference to expanded for a widening that may never come.
  it('does not offer to expand, or discard the saved preference, while the window holds an already-collapsed sidebar compact', () => {
    useUiStore.getState().setSidebarCollapsed(true);
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} compact constrained conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);

    expect(screen.getByRole('button', { name: 'Expand channels' })).toBeDisabled();

    const edge = screen.getByRole('separator', { name: 'Resize navigation' });
    fireEvent.focus(edge);
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Double-click');

    fireEvent.doubleClick(edge);
    fireEvent.keyDown(edge, { key: 'Enter' });
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  // Same as the work-stream divider: the press must not open what the hover
  // delay has not yet opened. A hint riding beside the edge for the length of
  // the drag covers the transcript the drag is revealing.
  it('keeps the hint shut through a grab that never waited for it', () => {
    useUiStore.getState().setSidebarCollapsed(false);
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
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

  // A window too narrow to hold the expanded sidebar pins it compact and
  // disables the footer toggle, and the double-click on the divider is guarded
  // by the same condition. The hint is the only place that shortcut is written
  // down, so it has to stop offering what the handle would refuse to do.
  it('stops naming the double-click while the window holds navigation compact', () => {
    useUiStore.getState().setSidebarCollapsed(false);
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} compact constrained conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);

    fireEvent.focus(screen.getByRole('separator', { name: 'Resize navigation' }));

    expect(screen.getByRole('tooltip')).toHaveTextContent('Drag to resize');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Double-click');
  });

  // The width animates because the width itself is transitioned, and a drag
  // takes that transition off for the length of the gesture. A double-click is
  // two grabs of the same handle, so the second release has to have put it back
  // before the toggle lands — otherwise the sidebar jumps to its collapsed
  // width and the animation is missing on exactly the gesture that asks for it,
  // with nothing else to say so.
  it('leaves the resize suppression off when a double-click on the edge toggles', () => {
    useUiStore.getState().setSidebarCollapsed(false);
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    const edge = screen.getByRole('separator', { name: 'Resize navigation' });
    edge.setPointerCapture = vi.fn();
    const navigation = screen.getByRole('complementary', { name: 'Rally navigation' });

    for (const pointerId of [7, 8]) {
      fireEvent.pointerDown(edge, { button: 0, clientX: 300, pointerId });
      expect(navigation).toHaveClass('is-resizing');
      fireEvent.pointerUp(window, { pointerId });
    }

    expect(navigation).not.toHaveClass('is-resizing');
    fireEvent.doubleClick(edge);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(navigation).not.toHaveClass('is-resizing');
  });

  // The handle is drawn at the sidebar's trailing edge, so while a collapse is
  // still travelling that edge is ahead of the width the state holds. Taking the
  // offset from the state leaves the drag wrong by whatever the animation had
  // left to run — and wrong for its whole length, not just the first frame.
  it('grabs the edge where it is drawn rather than where it is heading', () => {
    useUiStore.getState().setSidebarCollapsed(true);
    function Navigation() {
      const compact = useUiStore((state) => state.sidebarCollapsed);
      return <Sidebar {...defaultActions} compact={compact} conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />;
    }
    render(<MemoryRouter><Tooltip.Provider><Navigation /></Tooltip.Provider></MemoryRouter>);
    const resizer = screen.getByRole('separator', { name: 'Resize navigation' });
    resizer.setPointerCapture = vi.fn();
    // Mid-collapse: heading for the 96px rail, still drawn at 184px.
    layOutPanelAt(184);

    fireEvent.pointerDown(resizer, { button: 0, clientX: 185, pointerId: 4 });
    fireEvent.pointerMove(window, { clientX: 305, pointerId: 4 });

    // 120px of pointer travel from a 184px edge is a 304px sidebar. Measured
    // from the 96px target instead, the same travel asks for 216px — under the
    // 220px expand threshold, so the sidebar would not have moved at all.
    expect(resizer).toHaveAttribute('aria-valuenow', '304');
    fireEvent.pointerUp(window, { pointerId: 4 });
  });

  // Held arrow keys are the keyboard's drag: the same width written over and
  // over. Animating each step leaves the edge behind the width the collapse
  // threshold is judged against, so the sidebar snaps to the rail at a width
  // the reader never saw. The suppression lasts exactly as long as the key.
  it('suppresses the collapse animation while an arrow key is held', () => {
    useUiStore.getState().setSidebarCollapsed(false);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
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

  it('names compact links and connects their hover descriptions to the link', async () => {
    const item = workstream('compact-preview', 'Named compact destination', 'completed');
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} compact conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[item]} /></Tooltip.Provider></MemoryRouter>);
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
            automations={[]}
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

  it('shows a last-change timestamp only for unread rows and no participant stacks or Command hints', () => {
    const read = { ...workstream('read-row', 'Read destination', 'completed'), participantUserIds: ['user-1'] };
    const unread = { ...workstream('unread-row', 'Unread destination', 'completed'), hasUnread: true, preview: 'Do not display this preview' };
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[read, unread]} /></Tooltip.Provider></MemoryRouter>);
    const readLink = screen.getByRole('link', { name: read.title });
    const unreadLink = screen.getByRole('link', { name: new RegExp(unread.title, 'u') });
    expect(readLink.querySelector('time')).toBeNull();
    expect(unreadLink.querySelector('time')).toHaveAttribute('datetime', unread.lastActivityAt);
    expect(unreadLink.querySelector('.sidebar-row-activity')).toContainElement(unreadLink.querySelector('time'));
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
            automations={[]}
            onSignOut={vi.fn()}
            spaces={[hiring, company]}
            workspace={workspace}
            workstreams={[member]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
    expect(screen.getAllByRole('link', { name: /Ship the launch/u })).toHaveLength(1);
    fireEvent.click(screen.getByRole('link', { name: 'Company' }));
    const row = screen.getByRole('link', { name: /Ship the launch/u });
    expect(row).toHaveClass('sidebar-row', 'workstream-row');
    expect(row.querySelector('.sidebar-row-title')).toHaveTextContent('Ship the launch');
    expect(row.querySelector('.sidebar-row-activity')).toBeNull();
  });

  it('falls back once when a Space route is absent from the active directory', () => {
    const hiring = space();
    render(
      <MemoryRouter initialEntries={['/spaces/archived-space']}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} spaces={[hiring]}
            workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Hiring' })).toBeVisible();
  });

  it('adds one history entry when a Space is selected', () => {
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
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} spaces={[hiring]}
            workspace={workspace} workstreams={[]} />
          <HistoryProbe />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
    expect(screen.getByRole('status', { name: 'Current route' })).toHaveTextContent(`/spaces/${hiring.id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('status', { name: 'Current route' })).toHaveTextContent('/starting-point');
  });

  it('keeps Spaces expanded until a Channel in the selected Space is opened', () => {
    const hiring = space();
    const target = placedIn(workstream('hiring-plan', 'Hiring plan', 'completed'), hiring.id);
    render(
      <MemoryRouter initialEntries={['/starting-point']}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} spaces={[hiring]}
            workspace={workspace} workstreams={[target]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
    expect(screen.getByRole('complementary', { name: 'Spaces sidebar' })).not.toHaveClass('is-compact');

    fireEvent.click(screen.getByRole('link', { name: /Hiring plan/u }));
    expect(screen.getByRole('complementary', { name: 'Spaces sidebar' })).toHaveClass('is-compact');
  });

  it('preserves a manually collapsed Channels sidebar when a Space is selected', () => {
    const hiring = space();
    useUiStore.getState().setSidebarCollapsed(true);
    function Navigation() {
      const compact = useUiStore((state) => state.sidebarCollapsed);
      return <Sidebar {...defaultActions} automations={[]} compact={compact} onSignOut={vi.fn()}
        spaces={[hiring]} workspace={workspace} workstreams={[]} />;
    }
    render(
      <MemoryRouter initialEntries={['/starting-point']}>
        <Tooltip.Provider>
          <Navigation />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));

    expect(screen.getByRole('complementary', { name: 'Rally navigation' })).toHaveClass('is-compact');
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(localStorage.getItem('rally.sidebar-collapsed')).toBe('true');
  });

  it('collapses only the Spaces sidebar when the same Channel is re-entered', () => {
    const hiring = space();
    const target = placedIn(workstream('route-reset', 'Route reset', 'completed'), hiring.id);
    function Navigation() {
      const compact = useUiStore((state) => state.sidebarCollapsed);
      return <Sidebar {...defaultActions} automations={[]} compact={compact} onSignOut={vi.fn()}
        spaces={[hiring]} workspace={workspace} workstreams={[target]} />;
    }
    render(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider>
          <Navigation />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand spaces' }));
    expect(screen.getByRole('complementary', { name: 'Spaces sidebar' })).not.toHaveClass('is-compact');
    expect(screen.getByRole('complementary', { name: 'Rally navigation' })).not.toHaveClass('is-compact');

    fireEvent.click(screen.getByRole('link', { name: /Route reset/u }));
    expect(screen.getByRole('complementary', { name: 'Spaces sidebar' })).toHaveClass('is-compact');
    expect(screen.getByRole('complementary', { name: 'Rally navigation' })).not.toHaveClass('is-compact');
  });

  it('centers the containing Space and active Channel when a deep link opens', async () => {
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
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()}
            spaces={[other, hiring]} workspace={workspace} workstreams={[target, neighbor]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(scrolled).toHaveLength(2));
    expect(scrolled.map((row) => row.getAttribute('data-space-id')).filter(Boolean)).toEqual([hiring.id]);
    expect(scrolled.map((row) => row.getAttribute('data-workstream-id')).filter(Boolean)).toEqual([target.id]);
    for (const call of vi.mocked(Element.prototype.scrollIntoView).mock.calls) {
      expect(call[0]).toEqual({ block: 'center', behavior: 'auto' });
    }

    markDeepLinkWorkstreamNavigation(target.id);
    await waitFor(() => expect(scrolled).toHaveLength(4));

    fireEvent.click(screen.getByRole('link', { name: /Ordinary navigation/u }));
    expect(scrolled).toHaveLength(4);
  });

  it('waits for the live Space hierarchy before consuming a deep-link reveal', async () => {
    const hiring = space('00000000-0000-7000-8000-0000000000a2', 'Hiring');
    const target = placedIn(workstream('waiting-deep-link', 'Waiting deep link', 'completed'), hiring.id);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    markDeepLinkWorkstreamNavigation(target.id);
    const view = render(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} spaces={[]}
            spacesReady={false} workspace={workspace} workstreams={[target]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
    view.rerender(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} spaces={[hiring]}
            spacesReady workspace={workspace} workstreams={[target]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
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
          <Sidebar {...defaultActions} automations={[]} hasMoreWorkstreams onLoadMoreWorkstreams={onLoadMoreWorkstreams}
            onSignOut={vi.fn()} spaces={[hiring]} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(onLoadMoreWorkstreams).toHaveBeenCalledOnce());
    expect(scrollIntoView).not.toHaveBeenCalled();
    view.rerender(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} hasMoreWorkstreams onLoadMoreWorkstreams={onLoadMoreWorkstreams}
            onSignOut={vi.fn()} spaces={[hiring]} workspace={workspace} workstreams={[firstPage]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(onLoadMoreWorkstreams).toHaveBeenCalledTimes(2));
    view.rerender(
      <MemoryRouter initialEntries={[`/workstreams/${target.id}`]}>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onLoadMoreWorkstreams={onLoadMoreWorkstreams}
            onSignOut={vi.fn()} spaces={[hiring]} workspace={workspace} workstreams={[firstPage, target]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
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
        <Sidebar {...defaultActions} automations={[]} loading onSignOut={vi.fn()}
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
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
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
            automations={[]}
            loading
            onSignOut={vi.fn()}
            spaces={[]}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    // The Space rail reserves four tiles while its directory arrives; the
    // Channel rail seven glyph rows, ungrouped as the list under a Space is.
    expect(container.querySelectorAll('.skeleton-row')).toHaveLength(11);
    expect(container.querySelectorAll('.skeleton-row-mark.is-tile')).toHaveLength(4);
    expect(container.querySelectorAll('.skeleton-row-mark.is-glyph')).toHaveLength(7);
    expect(container.querySelector('.skeleton-group-label')).toBeNull();
    // The Channel rail is headed by its Space's placeholder, never New.
    expect(container.querySelector('.channels-sidebar .skeleton-title-header')).not.toBeNull();
    expect(container.querySelector('.channels-sidebar .sidebar-titlebar .sidebar-new-button')).toBeNull();
    // The mobile close control stays reachable while the Space loads.
    expect(within(container.querySelector<HTMLElement>('.channels-sidebar .skeleton-title-header')!)
      .getByRole('button', { name: 'Close navigation' })).toBeInTheDocument();
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
            automations={[]}
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
    expect(container.querySelector('.skeleton-title-header')).toBeNull();
    expect(screen.getByText('Launch brief')).toBeInTheDocument();
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

  it('leaves channel glyphs whole across run and attention states', () => {
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
    expect(document.querySelectorAll('.workstream-row .status-dot')).toHaveLength(0);
    expect(screen.getByRole('link', { name: /Board decision/u })).toHaveAccessibleDescription(/1 conversation needs attention/u);
    expect(screen.getByRole('link', { name: /Completed mention/u })).toHaveAccessibleDescription(/1 conversation needs attention/u);
    expect(screen.getByRole('link', { name: /Completed unseen/u })).toHaveAccessibleDescription(/1 conversation needs attention/u);
    expect(within(screen.getByRole('link', { name: /Missing sidebar row/u })).queryByText('1')).not.toBeInTheDocument();
    expect(document.querySelector('.sidebar-automation-marker')).toBeNull();
    expect(screen.queryByRole('img', { name: /Automation-generated/u })).not.toBeInTheDocument();
    expect(document.querySelector('.brand-lockup')).toBeNull();
    expect(document.querySelector('.sidebar-titlebar')).not.toBeNull();
  });

  it('counts Main and Breakout attention together on a Channel row and omits zero', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
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

    const launch = screen.getByRole('link', { name: 'Launch' });
    expect(launch).toHaveAccessibleDescription(/3 conversations need attention/u);
    expect(within(launch).getByText('3')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('link', { name: 'Shared channel' })).toHaveAccessibleDescription(/1 conversation needs attention/u);
    expect(within(screen.getByRole('link', { name: 'Roadmap' })).queryByText('0')).not.toBeInTheDocument();
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
            automations={[]}
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
              automations={[]}
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
            automations={[]}
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

  // Search sits above the scroll box in both layouts, so it stays fixed
  // however far the list is scrolled. The rail's New work stream row arrives
  // above it with the compact toggle and leaves with the expand, and is marked
  // so the list motion shows it doing so; the titlebar's own is hidden in the
  // rail rather than unmounted, so it can fade with the layout.
  it('keeps search above the scroll box in both layouts, with the rail\'s New channel row inserted above it', async () => {
    const onOpenSearch = vi.fn();
    const view = (compact: boolean): React.JSX.Element => (
      <MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} compact={compact} conversationOnly automations={[]} onOpenSearch={onOpenSearch} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>
    );
    const { rerender } = render(view(true));
    const search = screen.getByRole('button', { name: 'Search organization' });
    const create = screen.getByRole('button', { name: 'New channel' });
    expect(screen.getByRole('navigation')).not.toContainElement(search);
    const bar = search.closest('.sidebar-commandbar');
    expect(bar).not.toBeNull();
    expect(bar).toContainElement(create);
    expect(create.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create).toHaveAttribute('data-motion-key', 'action:new');
    expect(create).toHaveAttribute('data-motion-insert');
    fireEvent.focus(search);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Search');
    expect(search).not.toHaveAttribute('aria-describedby');
    fireEvent.blur(search);
    fireEvent.click(search);
    expect(onOpenSearch).toHaveBeenCalledOnce();
    expect(create).toHaveAttribute('aria-haspopup', 'menu');

    rerender(view(false));
    expect(screen.getByRole('navigation')).not.toContainElement(screen.getByRole('button', { name: 'Search organization' }));
    const [titlebarCreate, ...others] = screen.getAllByRole('button', { name: 'New channel' });
    expect(others).toEqual([]);
    expect(titlebarCreate?.closest('.sidebar-titlebar')).not.toBeNull();
    expect(bar?.querySelector('[data-motion-key="action:new"]')).toBeNull();
    const expandedSearch = screen.getByRole('button', { name: 'Search organization' });
    fireEvent.focus(expandedSearch);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Search');
    expect(expandedSearch).not.toHaveAttribute('aria-describedby');
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
    // Below the list and above the account row in both layouts: the rail keeps
    // the strip where the full sidebar has it rather than folding it into the
    // scrolling list.
    expect(strip.closest('.sidebar-scroll')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open account menu' })).toBeVisible();
    expect(within(strip).getAllByRole('button')).toHaveLength(2);
    for (const item of excluded) expect(screen.queryByText(item.name)).toBeNull();
    // Running says so with a play in the success colour, drawn into the hexagon
    // rather than laid over it. The dot this replaced said only "a state is
    // true here", and inherited the work-stream marker's radius on the way, so
    // what a person actually saw was an unnamed dark square.
    const tile = within(strip).getByRole('button', { name: 'Team brief, Active · Organization' });
    const marker = tile.querySelector('.automation-glyph-marker');
    expect(marker).toHaveClass('lucide-play');
    expect(marker).toHaveAttribute('fill', 'var(--av-sys-color-success-base)');
    // The state reaches a screen reader through that name and nowhere else. The
    // tile used to also render a visually hidden "Active", which read as the
    // accessibility path while contributing nothing: `aria-label` on a button
    // replaces its contents in the accessible name, so the span was never
    // announced. Queried above by the exact name, so a second source for the
    // state has to keep the name right rather than appending to it.
    expect(tile.querySelector('.sr-only')).toBeNull();
    fireEvent.click(within(strip).getByRole('button', { name: 'Team brief, Active · Organization' }));
    expect(openSidekicks).toHaveBeenCalledWith('shared');
    // The Sidekicks window is a separate renderer with its own copy of the
    // telemetry module, and its surface mounts no route observer, so a marker
    // set here reaches nothing and is left for this window's next navigation to
    // consume as `sidebar_automation`.
    expect(markSurfaceEntrypoint).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /Daily product brief/u })).toBeNull();
  });

  it('reads a truncated tile through the renderer\'s own tooltip, and its play through a second', async () => {
    const shared = { ...automation, loadable: false, id: 'shared', name: 'Team brief', scope: 'workspace' as const };
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} conversationOnly automations={[shared]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    const strip = screen.getByRole('region', { name: 'Sidekick shortcuts' });
    const tile = within(strip).getByRole('button', { name: 'Team brief, Active · Organization' });

    // One tooltip language per slot. `title` is the desktop's own: a different
    // delay, a different type, no theme, and nothing at all on keyboard focus —
    // which is the whole cost here, because the caption is ellipsized at 80px
    // and the rail drops it, so the tooltip is how the tile is read.
    expect(tile).not.toHaveAttribute('title');

    fireEvent.pointerMove(tile, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Team brief · Organization');
    // Not the state: every tile in this strip is active, the play in the corner
    // reports it, and the tile's one line is better spent on which Sidekick it
    // is. A screen reader still gets the state, out of the accessible name
    // asserted above.
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Active');

    fireEvent.pointerMove(tile.querySelector('.automation-glyph-marker')!.parentElement!, { pointerType: 'mouse' });
    await waitFor(
      () => expect(screen.getByRole('tooltip')).toHaveTextContent('in service and waiting on its triggers'),
    );
    // And only that one, because there is only one: the tile has a single
    // tooltip slot and the pointer decides what it says.
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  });

  /** The strip with one workspace Sidekick, and the tile that carries its play. */
  function renderStripTile(): HTMLElement {
    const shared = { ...automation, loadable: false, id: 'shared', name: 'Team brief', scope: 'workspace' as const };
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} conversationOnly automations={[shared]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    const strip = screen.getByRole('region', { name: 'Sidekick shortcuts' });
    return within(strip).getByRole('button', { name: 'Team brief, Active · Organization' });
  }

  /** The marker's hover target: the `<g>` the hexagon wraps its play in. */
  function playTarget(tile: HTMLElement): HTMLElement {
    return tile.querySelector('.automation-glyph-marker')!.parentElement as HTMLElement;
  }

  it('opens on keyboard focus, which is the whole of what the native tooltip could not do', async () => {
    const tile = renderStripTile();

    // The reason this rail took `Tip` at all. A `title` draws nothing for a
    // reader who arrives by Tab, on the one row whose caption is ellipsized at
    // 80px and dropped outright by the rail.
    act(() => { tile.focus(); });

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Team brief · Organization');
  });

  it('says what the play means to a reader who cannot rest a pointer on it', () => {
    const tile = renderStripTile();

    // The marker is drawn inside `aria-hidden` artwork and its target is a
    // non-focusable `<g>`, so the sentence reaches assistive technology only
    // because the tile carries it. Giving the target a tab stop instead would
    // put one inside every tile in the strip.
    expect(tile).toHaveAccessibleDescription('Active — in service and waiting on its triggers.');
    expect(playTarget(tile)).not.toHaveAttribute('tabindex');
  });

  it('answers for the play when the pointer reaches it inside the tile tooltip\'s own delay', () => {
    // The path a pointer actually takes: across the tile, onto the play, before
    // the tile's 450ms is up. Two tooltips cannot resolve this between them —
    // a Radix root tells every other root to close the moment it *decides* to
    // open, so the tile's pending open closed the play's explanation on its way
    // to being refused, and the tile showed nothing at all. One root has one
    // answer, and it is the one the pointer is on.
    vi.useFakeTimers();
    try {
      const tile = renderStripTile();

      fireEvent.pointerMove(tile, { pointerType: 'mouse' });
      // Short of 450ms: the tile's open is pending, and nothing is up yet.
      act(() => { vi.advanceTimersByTime(120); });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

      fireEvent.pointerMove(playTarget(tile), { pointerType: 'mouse' });
      // Each advance flushes on its own, the way separate timers land in a
      // browser. Advancing straight past both at once lets a tooltip mount
      // after an event it should have heard, which reads as a pass for a race
      // that is still there.
      act(() => { vi.advanceTimersByTime(400); });
      act(() => { vi.advanceTimersByTime(2_000); });

      expect(screen.getAllByRole('tooltip').map((tip) => tip.textContent))
        .toEqual(['Active — in service and waiting on its triggers.']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('swaps its answer both ways as the pointer moves between the tile and its play', () => {
    // No second delay on the way in and no gap on the way out: the slot is
    // already open, so it re-labels rather than closing and waiting again.
    vi.useFakeTimers();
    try {
      const tile = renderStripTile();

      fireEvent.pointerMove(tile, { pointerType: 'mouse' });
      act(() => { vi.advanceTimersByTime(600); });
      expect(screen.getByRole('tooltip')).toHaveTextContent('Team brief · Organization');

      fireEvent.pointerMove(playTarget(tile), { pointerType: 'mouse' });
      act(() => { vi.advanceTimersByTime(50); });
      expect(screen.getAllByRole('tooltip').map((tip) => tip.textContent))
        .toEqual(['Active — in service and waiting on its triggers.']);

      // And back, which two roots could not do: the tile's trigger opens once
      // per pointer entry, so a tooltip it had given up would not return until
      // the pointer left the tile and came back.
      fireEvent.pointerLeave(playTarget(tile));
      fireEvent.pointerMove(tile, { pointerType: 'mouse' });
      act(() => { vi.advanceTimersByTime(50); });
      expect(screen.getAllByRole('tooltip').map((tip) => tip.textContent))
        .toEqual(['Team brief · Organization']);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('offers making the first Sidekick where the shortcuts would be (compact=%s)', (compact) => {
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} compact={compact} conversationOnly automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    // Named for what it holds: an offer to make one, not shortcuts to any.
    const strip = screen.getByRole('region', { name: 'Sidekicks' });
    expect(screen.queryByRole('region', { name: 'Sidekick shortcuts' })).toBeNull();
    // The same tile a Sidekick gets, so it sheds its caption and shrinks to the
    // rail's square with them rather than keeping a shape of its own.
    const create = within(strip).getByRole('button', { name: 'New Sidekick' });
    expect(create).toHaveClass('automation-tile');
    expect(create.querySelector('.sidekick-new-glyph')).not.toBeNull();
    // No lifecycle marker: there is no Sidekick yet to have one, so the hexagon
    // is drawn whole rather than with a state cut out of it.
    expect(create.querySelector('.automation-glyph-marker')).toBeNull();
    expect(create.querySelector('mask')).toBeNull();
    expect(within(strip).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(create);
    expect(openSidekicks).toHaveBeenCalledWith('new');
    // Strands a marker in this window otherwise; see the Sidekick tile above.
    expect(markSurfaceEntrypoint).not.toHaveBeenCalled();
  });

  it('drops the new-Sidekick tile once one is enabled, and names the strip for the shortcuts it holds', () => {
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[automation]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    expect(within(screen.getByRole('region', { name: 'Sidekick shortcuts' })).queryByRole('button', { name: 'New Sidekick' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Sidekicks' })).toBeNull();
  });

  it('waits for the organization answer before saying an organization has no Sidekicks', () => {
    // The array itself carries the wait, so no caller has to remember a flag.
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={undefined} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    expect(screen.queryByRole('region', { name: 'Sidekick shortcuts' })).toBeNull();
  });

  it('keeps the new-Sidekick slot for drafts and resumes the most recently updated standalone draft', () => {
    const olderDraft = { ...automation, id: 'automation-draft-older', status: 'draft' as const };
    const newerDraft = { ...olderDraft, id: 'automation-draft-newer', updatedAt: '2026-07-21T09:00:00.000Z' };
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[olderDraft, newerDraft]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    const strip = screen.getByRole('region', { name: 'Sidekicks' });
    const create = within(strip).getByRole('button', { name: 'New Sidekick' });
    fireEvent.click(create);
    expect(openSidekicks).toHaveBeenCalledWith(newerDraft.id);
    expect(screen.queryByRole('region', { name: 'Sidekick shortcuts' })).toBeNull();
  });

  it('keeps the new-Sidekick slot for paused Sidekicks and starts a new draft', () => {
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[{ ...automation, status: 'paused' }]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    const create = within(screen.getByRole('region', { name: 'Sidekicks' })).getByRole('button', { name: 'New Sidekick' });
    fireEvent.click(create);
    expect(openSidekicks).toHaveBeenCalledWith('new');
  });

  it('does not resume an organization draft whose management authority is unknown', () => {
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[{ ...automation, scope: 'workspace', status: 'draft' }]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    const create = within(screen.getByRole('region', { name: 'Sidekicks' })).getByRole('button', { name: 'New Sidekick' });
    fireEvent.click(create);
    expect(openSidekicks).toHaveBeenCalledWith('new');
  });

  it('keeps the new-Sidekick slot when only a channel-owned Sidekick exists', () => {
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[{ ...automation, scope: 'workstream' }]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    const create = within(screen.getByRole('region', { name: 'Sidekicks' })).getByRole('button', { name: 'New Sidekick' });
    fireEvent.click(create);
    expect(openSidekicks).toHaveBeenCalledWith('new');
  });

  it('manages Sidekicks through the library instead of listing them in the sidebar', () => {
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[automation]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} /></Tooltip.Provider></MemoryRouter>);
    expect(screen.queryByRole('region', { name: 'Automations' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'New automation' })).toBeNull();
    // Scoped to the actions row: the titlebar's plus is a second way to the
    // same place and now carries the same name.
    const actions = document.querySelector('.sidebar-primary-actions');
    expect(actions).not.toBeNull();
    expect(within(actions as HTMLElement).getByRole('button', { name: 'New channel' })).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('archives a channel from the menu once the confirmation is accepted', async () => {
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
            <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()}
              spaces={[general(), hiring]} workspace={workspace} workstreams={[target]} />
          </Tooltip.Provider>
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));

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
            automations={[]}
            onSignOut={vi.fn()}
            ordering={[{
              container: { kind: 'organization' },
              itemIds: [launch.id, hiring.id, general().id],
            }]}
            spaces={[general(), hiring, launch]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const sidebarOrder = within(screen.getByRole('navigation', { name: 'Spaces' }))
      .getAllByRole('link')
      .map((link) => link.getAttribute('aria-label'));
    expect(sidebarOrder).toEqual(['Launch', 'Hiring', 'General']);

    // The row lives under the Space that holds it; there is no second, flat
    // list of the same Channel to reach it through.
    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u })!, { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Archive channel' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to space' }));
    const generalOption = await screen.findByRole('menuitemcheckbox', { name: 'General' });
    const existing = screen.getByRole('menuitemcheckbox', { name: 'Hiring' });
    const available = screen.getByRole('menuitemcheckbox', { name: 'Launch' });
    expect(screen.getAllByRole('menuitemcheckbox').map((option) => option.textContent))
      .toEqual(sidebarOrder);
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
    fireEvent.keyDown(available, { key: 'ArrowDown' });
    await waitFor(() => expect(existing).toHaveFocus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'This channel is already in Hiring.',
    );
  });

  it('orders the new Channel Space picker like the Space sidebar', async () => {
    const hiring = space();
    const launch = space('00000000-0000-7000-8000-0000000000f5', 'Launch');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            ordering={[{
              container: { kind: 'organization' },
              itemIds: [launch.id, hiring.id, general().id],
            }]}
            spaces={[general(), hiring, launch]}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const sidebarOrder = within(screen.getByRole('navigation', { name: 'Spaces' }))
      .getAllByRole('link')
      .map((link) => link.getAttribute('aria-label'));
    const launcher = screen.getByRole('button', { name: 'New channel or space' });
    fireEvent.keyDown(launcher, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start New Channel' }));

    const dialog = screen.getByRole('dialog', { name: 'Start a new channel' });
    const spacePicker = within(dialog).getByRole('combobox', { name: 'Space' });
    expect(spacePicker).toHaveTextContent('Launch');
    fireEvent.click(spacePicker);
    expect(screen.getAllByRole('option').map((option) => option.textContent))
      .toEqual(sidebarOrder);
  });

  it('keeps Add to space aligned with an in-flight Space reorder', async () => {
    let finishReorder: (() => void) | undefined;
    const onReorderContainer = vi.fn(() => new Promise<void>((resolve) => {
      finishReorder = resolve;
    }));
    const hiring = space();
    const launch = space('00000000-0000-7000-8000-0000000000f5', 'Launch');
    const target = placedIn(
      workstream('optimistic-menu-spaces', 'Quarterly planning', 'completed'),
      hiring.id,
      general().id,
    );
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onReorderContainer={onReorderContainer}
            onSignOut={vi.fn()}
            ordering={[{
              container: { kind: 'organization' },
              itemIds: [launch.id, hiring.id, general().id],
            }]}
            spaces={[general(), hiring, launch]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.keyDown(screen.getByRole('link', { name: 'Launch' }), {
      altKey: true,
      key: 'ArrowDown',
    });
    await waitFor(() => expect(onReorderContainer).toHaveBeenCalledWith({
      container: { kind: 'organization' },
      itemIds: [hiring.id, launch.id, general().id],
    }));
    const sidebarOrder = within(screen.getByRole('navigation', { name: 'Spaces' }))
      .getAllByRole('link')
      .map((link) => link.getAttribute('aria-label'));
    expect(sidebarOrder).toEqual(['Hiring', 'Launch', 'General']);

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), {
      clientX: 120,
      clientY: 90,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add to space' }));
    expect(screen.getAllByRole('menuitemcheckbox').map((option) => option.textContent))
      .toEqual(sidebarOrder);

    finishReorder?.();
    await waitFor(() => expect(onReorderContainer).toHaveBeenCalledOnce());
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
            automations={[]}
            onRemoveChannelFromSpace={onRemoveChannelFromSpace}
            onSignOut={vi.fn()}
            spaces={[launch, hiring]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
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
            automations={[]}
            onRemoveChannelFromSpace={onRemoveChannelFromSpace}
            onSignOut={vi.fn()}
            spaces={[hiring]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
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
            automations={[]}
            onRemoveChannelFromSpace={onRemoveChannelFromSpace}
            onSignOut={vi.fn()}
            spaces={[hiring]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
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
            automations={[]}
            onSignOut={vi.fn()}
            spaces={[general(), reached]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'General' }));
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
            automations={[]}
            onSignOut={vi.fn()}
            spaces={[hiring]}
            workspace={workspace}
            workstreams={[digest]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
    fireEvent.contextMenu(screen.getByRole('link', { name: /Digest/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Add to space' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Manage access' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Remove from space' })).not.toBeInTheDocument();
  });

  it('moves a channel from the center sidebar to the space its row was dropped on', () => {
    const onMoveChannelToSpace = vi.fn(async () => undefined);
    const hiring = space();
    const home = general();
    const target = placedIn(workstream('drag-to-space', 'Quarterly planning', 'completed'), home.id);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onMoveChannelToSpace={onMoveChannelToSpace}
            onSignOut={vi.fn()}
            spaces={[home, hiring]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const row = document.querySelector(`[data-workstream-id="${target.id}"]`);
    expect(row).toHaveAttribute('draggable', 'true');
    const item = screen.getByRole('link', { name: 'Hiring' });
    if (!(item instanceof HTMLElement)) throw new Error('space row missing');
    fireEvent.drop(item, {
      dataTransfer: {
        dropEffect: 'none',
        getData: (type: string) => type === 'application/x-rally-workstream-id'
          ? target.id
          : type === 'application/x-rally-channel-source-space-id' ? home.id : '',
      },
    });

    expect(onMoveChannelToSpace).toHaveBeenCalledWith(home.id, hiring.id, target.id);
  });

  // Every Channel belongs to at least one Space and the section is drawn in
  // every shell, so a row is always draggable onto something.
  it('given the conversation-only sidebar, then the Spaces and selected-Space Channels are still drawn', () => {
    const target = placedIn(workstream('drag-conversation-only', 'Quarterly planning', 'completed'), general().id);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            conversationOnly
            onSignOut={vi.fn()}
            spaces={[general()]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('complementary', { name: 'Spaces sidebar' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'General' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'General' })).toHaveClass('sidebar-title');
    const header = screen.getByRole('heading', { name: 'General' }).closest('.sidebar-header');
    expect(header).toHaveClass('sidebar-row');
    const titleIcon = header?.querySelector('.sidebar-title-header-icon');
    expect(titleIcon?.querySelector('svg')).toHaveAttribute('width', '20');
    expect(titleIcon?.querySelector('svg')).toHaveAttribute('height', '20');
    expect(titleIcon?.nextElementSibling).toBe(screen.getByRole('heading', { name: 'General' }));
    expect(header?.nextElementSibling).toHaveClass('sidebar-horizontal-line', 'sidebar-header-line');
    expect(screen.getByRole('navigation', { name: 'Channels' })).toHaveClass('sidebar-scroll');
    expect(screen.queryByRole('heading', { name: 'Channels' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Quarterly planning/u })).toHaveClass('sidebar-row');
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
            automations={[]}
            conversationOnly
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('heading', { name: 'Spaces' })).not.toBeInTheDocument();
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
            automations={[]}
            onSignOut={vi.fn()}
            spaces={[general()]}
            spacesReady={false}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByText(/Rally is opening this organization/u)).toBeVisible();
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
            automations={[]}
            onRetrySpaces={onRetrySpaces}
            onSignOut={vi.fn()}
            spaces={[general()]}
            spacesOutOfDate
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /General/u })).toBeVisible();
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
            automations={[]}
            onSignOut={vi.fn()}
            spaces={[hiring, launch]}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
    expect(screen.getByRole('link', { name: /Quarterly planning/u })).toHaveAttribute('href', `/workstreams/${target.id}`);
    fireEvent.click(screen.getByRole('link', { name: 'Launch' }));
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
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300 });
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
            automations={[]}
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

  it('explains the public badge on hover without displacing the row preview', async () => {
    renderWith([workstream('00000000-4000-4000-8000-00000000002f', 'Launch', 'completed')]);
    const row = screen.getByRole('link', { name: 'Launch' });
    expect(row).toHaveAccessibleDescription('Public channel');
    const globe = within(row).getByRole('img', { name: 'Public channel' });
    fireEvent.pointerEnter(row.closest('[data-workstream-id]')!);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Launch'), { timeout: 5_000 });

    // The badge is the smallest thing on the row and the only one whose meaning
    // has to be guessed, so it answers for itself. Radix asks every other open
    // tooltip to close when one opens; the preview drives its own `open` and
    // stays, which is what keeps the two explanations from taking turns.
    fireEvent.pointerMove(globe, { pointerType: 'mouse' });
    await waitFor(
      () => expect(screen.getAllByRole('tooltip').map((tip) => tip.textContent)).toEqual(
        expect.arrayContaining([expect.stringContaining('everyone in the organization can see this channel')]),
      ),
      { timeout: 5_000 },
    );
    expect(screen.getByRole('tooltip', { name: /Launch/u })).toBeInTheDocument();
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
    expect(row.querySelector('.sidebar-workstream-public')).not.toBeNull();
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
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300 });
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
            automations={[]}
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
      onPinWorkstream: (workstream: WorkstreamSummary, spaceId: string, pinned: boolean) => Promise<boolean>;
      onReorderPinnedWorkstreams: (spaceId: string, workstreamIds: string[]) => Promise<void>;
    }> = {},
  ): void {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            {...actions}
            automations={[]}
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
    expect(screen.getByRole('separator', { name: 'Pinned and unpinned channels' })).toBeVisible();
  });

  it('shows no Pinned section until something is pinned', () => {
    renderWith([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    expect(screen.queryByRole('region', { name: 'Pinned' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Pinned and unpinned channels' })).not.toBeInTheDocument();
  });

  it('renders pinned rows in their stored order rather than by activity', () => {
    renderWith([
      pinned(workstream('ws-a', 'Alpha', 'completed', '2026-07-31T20:00:00.000Z'), 1),
      pinned(workstream('ws-b', 'Bravo', 'completed', '2026-07-20T20:00:00.000Z'), 0),
    ]);

    expect(pinnedRowTitles()).toEqual([expect.stringContaining('Bravo'), expect.stringContaining('Alpha')]);
    expect(screen.queryByRole('separator', { name: 'Pinned and unpinned channels' })).not.toBeInTheDocument();
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
          automations={[]}
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

    fireEvent.keyDown(screen.getByRole('link', { name: /Bravo/u }), { key: 'ArrowUp', altKey: true });
    expect(onReorderPinnedWorkstreams).toHaveBeenCalledWith(launch.id, ['ws-b', 'ws-a']);

    fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
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
          automations={[]}
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

      fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

      // The animated element is the one the Pinned section now renders, and it
      // leaves and returns one row above its alphabetical slot, under the new
      // Pinned heading.
      const moved = playedOn('workstream:ws-recent');
      expect(moved).toBeDefined();
      expect(screen.getByRole('region', { name: 'Pinned' })).toContainElement(moved!.element);
      expect(moved!.keyframes[0]).toEqual(expect.objectContaining({ transform: 'translate(0px, -48px)' }));
      // The remaining alphabetical row shifts down one slot under Pinned.
      expect(playedOn('workstream:ws-first')?.keyframes).toEqual([{ transform: 'translate(0px, -48px)' }, { transform: 'translate(0px, 0px)' }]);
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
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} spaces={[launch, hiring]} workspace={workspace} workstreams={[member]} />
        </Tooltip.Provider></MemoryRouter>,
      );
      expect(screen.getByRole('link', { name: /Roadmap review/u })
        .closest('[data-motion-scope]')).toHaveAttribute('data-motion-scope', `space:${launch.id}`);
      fireEvent.click(screen.getByRole('link', { name: 'Hiring' }));
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
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={streams} />
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
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={streams} />
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

    // `transitionrun` arrives with the first frame after the toggle, and a
    // render can land before it. The toggle raises the hold itself, and a
    // frame later — jsdom runs no transitions, so nothing is travelling — the
    // sidebar releases it and the next move plays.
    it('raises the hold from the toggle itself, and releases it a frame later when nothing travels', async () => {
      const today = workstream('ws-today', 'Roadmap review', 'completed', '2026-08-01T09:00:00.000Z');
      const yesterday = workstream('ws-yesterday', 'Quarterly planning', 'completed', '2026-07-31T09:00:00.000Z');
      const view = (compact: boolean, streams: WorkstreamSummary[]): React.JSX.Element => (
        <MemoryRouter><Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} compact={compact} onSignOut={vi.fn()} workspace={workspace} workstreams={streams} />
        </Tooltip.Provider></MemoryRouter>
      );
      const { rerender } = render(view(false, [today, yesterday]));
      rerender(view(true, [today, yesterday]));
      const touched = { ...yesterday, lastActivityAt: '2026-08-01T11:00:00.000Z' };
      rerender(view(true, [today, touched]));
      // The rail's New work stream row arriving is the one thing that plays: no row moved.
      expect(animate.mock.calls.map(([element]) => (element as HTMLElement).dataset.motionKey)).toEqual(['action:new']);
      await act(() => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); }));
      // The touched row goes back to Yesterday and the other climbs two
      // slots past it: a move, and it plays.
      rerender(view(true, [today, yesterday]));
      expect(playedOn('workstream:ws-today')?.keyframes[0]).toEqual(expect.objectContaining({ transform: 'translate(0px, 96px)' }));
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
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[today, yesterday]} />
        </Tooltip.Provider></MemoryRouter>,
      );
      expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Today', 'Yesterday']);

      rerender(
        <MemoryRouter><Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[today, { ...yesterday, lastActivityAt: '2026-08-01T11:00:00.000Z' }]} />
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
      const [streams, setStreams] = useState([
        placedIn(workstream('ws-recent', 'Quarterly planning', 'completed'), TEST_SPACE_ID),
      ]);
      return (
        <Sidebar
          {...defaultActions}
          automations={[]}
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
            automations={[]}
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
            automations={[]}
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

  it('opens organization search without loading sidebar pages', () => {
    const onOpenSearch = vi.fn();
    const onLoadMoreWorkstreams = vi.fn();
    render(<MemoryRouter><Tooltip.Provider><Sidebar {...defaultActions} automations={[]}
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
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300 });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
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
            automations={[]}
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

  it('given a channel in no visible space, then the selected Space rail does not mix it in', () => {
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
    renderSidebar({ spaces: [hiring], workstreams: [placed, elsewhere] });

    expect(screen.getByRole('link', { name: /Roadmap review/u })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Quarterly planning/u })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'New channel' })).not.toBeInTheDocument();
  });

  // The section above already holds it, and a row in both would take its order
  // from whichever the reader saw last — the same rule the list this replaces
  // was under.
  it('given an impossible unplaced pinned channel after opening, then it is not mixed into the selected Space', () => {
    const hiring = space();
    const unplaced = { ...pinned(workstream('ws-pinned', 'Launch tracking', 'completed'), 0), spaceIds: [] };
    renderSidebar({ spaces: [hiring], workstreams: [unplaced] });

    expect(screen.queryByRole('link', { name: /Launch tracking/u })).not.toBeInTheDocument();
  });

  it('given a stored space order, when the section is drawn, then it is in that order', () => {
    const first = space('00000000-0000-7000-8000-0000000000f3', 'Alpha');
    const second = space('00000000-0000-7000-8000-0000000000f4', 'Bravo');
    renderSidebar({
      spaces: [first, second],
      ordering: [{ container: { kind: 'organization' }, itemIds: [second.id, first.id] }],
    });

    const section = screen.getByRole('navigation', { name: 'Spaces' });
    expect(within(section).getAllByRole('link').map((link) => link.textContent))
      .toEqual([expect.stringContaining('Bravo'), expect.stringContaining('Alpha')]);
  });
});

describe('alphabetical channels inside a space', () => {
  beforeEach(() => {
    window.localStorage.clear();
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true };
    applicationSettings.listeners.clear();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300 });
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
            automations={[]}
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
            automations={[]}
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
    const list = document.querySelector(`[data-motion-scope="space:${hiring.id}"]`);
    if (!list) throw new Error('The space has no placement list');
    return within(list as HTMLElement).getAllByRole('link').map((row) => row.textContent ?? '');
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
      ordering: [{ container: { kind: 'space', id: hiring.id }, itemIds: [zulu.id, bravo.id, lowercase.id] }],
      workstreams: [zulu, duplicateLater, duplicateEarlier, uppercase, bravo, lowercase, accented],
    });

    expect(placementTitles()).toEqual(['Åland', 'alpha', 'Alpha', 'Bravo', 'Same', 'Same', 'Zulu']);
    const list = document.querySelector(`[data-motion-scope="space:${hiring.id}"]`);
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
    const onReorderContainer = vi.fn(async () => undefined);
    renderSidebar({ onMoveChannelToSpace, onReorderContainer });

    const transfer = channelTransfer();
    const target = screen.getByRole('link', { name: 'Launch' });
    fireEvent.dragStart(dragTarget(/Bravo/u), { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    fireEvent.dragEnd(dragTarget(/Bravo/u), { dataTransfer: transfer });

    await waitFor(() => expect(onMoveChannelToSpace).toHaveBeenCalledWith(hiring.id, launch.id, bravo.id));
    expect(onReorderContainer).not.toHaveBeenCalled();
    expect(placementTitles()).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Bravo')]);
  });

  it('opens the next Channel down when the current Channel is moved out of the selected Space', async () => {
    renderSidebarAt(alpha.id, [alpha, bravo]);
    const transfer = channelTransfer();

    fireEvent.dragStart(dragTarget(/Alpha/u), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole('link', { name: 'Launch' }), { dataTransfer: transfer });

    await waitFor(() => expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/workstreams/${bravo.id}`));
  });

  it('opens the Channel above when the current Channel is moved from the bottom', async () => {
    renderSidebarAt(bravo.id, [alpha, bravo]);
    const transfer = channelTransfer();

    fireEvent.dragStart(dragTarget(/Bravo/u), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole('link', { name: 'Launch' }), { dataTransfer: transfer });

    await waitFor(() => expect(screen.getByRole('status', { name: 'Current route' }))
      .toHaveTextContent(`/workstreams/${alpha.id}`));
  });

  it('opens the Space it left when the moved Channel was the selected Space\'s last one', async () => {
    renderSidebarAt(alpha.id, [alpha]);
    const transfer = channelTransfer();

    fireEvent.dragStart(dragTarget(/Alpha/u), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole('link', { name: 'Launch' }), { dataTransfer: transfer });

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
    fireEvent.drop(screen.getByRole('link', { name: 'Launch' }), { dataTransfer: transfer });
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
    fireEvent.drop(screen.getByRole('link', { name: 'Launch' }), { dataTransfer: transfer });
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
        automations={[]}
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
    fireEvent.drop(screen.getByRole('link', { name: 'Launch' }), { dataTransfer: transfer });
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
    fireEvent.drop(screen.getByRole('link', { name: 'Launch' }), { dataTransfer: transfer });
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
    fireEvent.drop(screen.getByRole('link', { name: 'Launch' }), { dataTransfer: transfer });
    fireEvent.dragEnd(dragTarget(/Bravo/u), { dataTransfer: transfer });

    await waitFor(() => expect(onMoveChannelToSpace).toHaveBeenCalledWith(hiring.id, launch.id, bravo.id));
    expect(onReorderPinnedWorkstreams).not.toHaveBeenCalled();
    await waitFor(() => expect(pinnedTitles())
      .toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Bravo')]));
  });

  it('does not reorder the alphabetical section with Alt+Arrow', () => {
    const onReorderContainer = vi.fn(async () => undefined);
    renderSidebar({ onReorderContainer });

    fireEvent.keyDown(dragTarget(/Bravo/u), { altKey: true, key: 'ArrowUp' });

    expect(onReorderContainer).not.toHaveBeenCalled();
    expect(placementTitles()).toEqual(['Alpha', 'Bravo']);
  });

  it('reveals Pinned for the first channel drag and pins the dropped channel', async () => {
    const onPinWorkstream = vi.fn(async () => true);
    renderSidebar({ onPinWorkstream, workstreams: [alpha, bravo] });
    const transfer = channelTransfer();
    const source = dragTarget(/Bravo/u);

    expect(screen.queryByRole('region', { name: 'Pinned' })).not.toBeInTheDocument();
    fireEvent.dragStart(source, { dataTransfer: transfer });
    expect(transfer.getData('application/x-rally-workstream-id')).toBe(bravo.id);
    const pinnedTarget = screen.getByRole('region', { name: 'Pinned' });
    expect(within(pinnedTarget).getByText('Drop channel here to pin')).toHaveClass('pinned-empty-drop-surface');
    fireEvent.dragOver(pinnedTarget, { dataTransfer: transfer });
    fireEvent.drop(pinnedTarget, { dataTransfer: transfer });
    fireEvent.dragEnd(source, { dataTransfer: transfer });

    await waitFor(() => expect(onPinWorkstream).toHaveBeenCalledWith(bravo, hiring.id, true));
  });

  it('hides the empty Pinned drop surface when the Channel drag is cancelled', () => {
    renderSidebar({ workstreams: [alpha, bravo] });
    const transfer = channelTransfer('none');
    const source = dragTarget(/Bravo/u);

    fireEvent.dragStart(source, { dataTransfer: transfer });
    expect(screen.getByText('Drop channel here to pin')).toBeInTheDocument();

    fireEvent.dragEnd(source, { dataTransfer: transfer });

    expect(screen.queryByRole('region', { name: 'Pinned' })).not.toBeInTheDocument();
    expect(screen.queryByText('Drop channel here to pin')).not.toBeInTheDocument();
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
