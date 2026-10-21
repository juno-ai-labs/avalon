import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { ARTIFACT_PINS_QUERY_KEY, CHANNEL_STATS_QUERY_KEY, MY_THREADS_QUERY_KEY, PINS_QUERY_KEY, SPACES_QUERY_KEY } from '../lib/sidebar-list-store';
import type { ArtifactPin, ChannelStats } from '@rally/contracts';
import type { SpaceConversationSummary, Workspace } from '../lib/types';
import { markDeepLinkWorkstreamNavigation } from '../lib/deep-link-navigation';
import type * as TelemetryModule from '../lib/telemetry';
import { useUiStore } from '../lib/ui-store';
import { NavigationSidebar } from './navigation-sidebar';

const api = vi.hoisted(() => ({
  createSpace: vi.fn(),
  getMyThreads: vi.fn(),
  getActivity: vi.fn(),
  markActivitySeen: vi.fn(async () => undefined),
  setPinned: vi.fn(),
  reorderPins: vi.fn(),
  setArtifactPinned: vi.fn(),
  reorderArtifactPins: vi.fn(),
  getChannelStats: vi.fn(async () => []),
  getWorkspaceMembers: vi.fn(async () => [{ id: 'maya', name: 'Maya K', email: 'maya@rally.test', timezone: 'UTC' }]),
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
/** The threads the workspace socket holds; empty unless a test puts some there. */
const live = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => ({ data: live.rows }) }));
const telemetry = vi.hoisted(() => ({
  markWorkstreamFeedOpenStarted: vi.fn(),
  markWorkstreamNavigation: vi.fn(),
  markSurfaceEntrypoint: vi.fn(),
  reportTelemetryProductIntent: vi.fn(),
}));
vi.mock('../lib/telemetry', async (original) => ({ ...await original<typeof TelemetryModule>(), ...telemetry }));
const warmup = vi.hoisted(() => ({ onPointerCancel: vi.fn(), onPointerEnter: vi.fn(), onPointerLeave: vi.fn() }));
const warmedThreads = vi.hoisted(() => [] as string[]);
vi.mock('../lib/workstream-socket-pool', () => ({
  useWorkstreamSocketHoverWarmup: (threadId: string) => {
    warmedThreads.push(threadId);
    return warmup;
  },
  useWorkstreamSocketOpenContext: () => () => ({ state: 'retained_pair', socketLeaseId: 'lease-1' }),
}));

const workspace: Workspace = {
  id: 'org', name: 'Rally', region: 'enterprise', timezone: 'UTC',
  currentUser: { id: 'me', name: 'Me', email: 'me@rally.test', timezone: 'UTC', role: 'owner', accessClass: 'member' },
};

function channel(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id, name, iconKey: 'briefcase', colorKey: 'blue', scope: 'workspace', status: 'active', systemRole: null,
    revision: 1, reach: 'organization', participants: [], channelCount: 0, attentionCount: 0,
    defaultResourceIds: [], defaultSidekickIds: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function stats(channelId: string, overrides: Partial<ChannelStats> = {}): ChannelStats {
  return {
    channelId, threadCount: 0, newThreadCount: 0, lastActivityAt: null,
    latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0, firstUnreadSequenceNumber: null, hasUnread: false,
    ...overrides,
  };
}

function thread(id: string, title: string, overrides: Partial<SpaceConversationSummary> = {}): SpaceConversationSummary {
  return {
    id, title, titleStatus: 'settled', scope: 'workspace', harnessStatus: 'completed',
    latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0, manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0, hasUnread: false, firstUnreadSequenceNumber: null, nextPendingWakeup: null,
    participantUserIds: [], participantExtraCount: 0, spaceIds: ['outbound'], pinPosition: null,
    lastActivityAt: '2026-10-01T00:00:00.000Z', kind: 'channel', breakoutOf: null,
    ...overrides,
  } as SpaceConversationSummary;
}

function artifactPin(id: string, title: string, mimeType = 'text/markdown', overrides: Partial<ArtifactPin> = {}): ArtifactPin {
  return {
    id, threadId: 'launch' as ArtifactPin['threadId'], title, resourceType: 'generated_file', mimeType,
    updatedAt: '2026-10-01T00:00:00.000Z', currentVersion: 1, unread: false,
    thread: { title: 'Launch', appearance: null, spaceIds: ['outbound'] },
    ...overrides,
  };
}

/** Each thread row's name and second line. */
function threadRows(list: ReturnType<typeof within>): Array<[string | null | undefined, string | null | undefined]> {
  return list.getAllByRole('link').filter((row: HTMLElement) => row.classList.contains('navigation-thread-row'))
    .map((row: HTMLElement) => [row.querySelector('.navigation-row-title')?.textContent, row.querySelector('.navigation-row-detail')?.textContent]);
}

function Location(): React.JSX.Element {
  const location = useLocation();
  return <div data-key={location.key} data-state={JSON.stringify(location.state)} data-testid="location">{location.pathname}{location.search}</div>;
}

function renderSidebar(seed: (client: QueryClient) => void, waiting = 0, { route = '/', person = workspace }: { route?: string; person?: Workspace } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  return render(<QueryClientProvider client={client}><Tooltip.Provider>
    <MemoryRouter initialEntries={[route]}>
      <NavigationSidebar
        accessDecisionFailed={false}
        accessRequests={[]}
        accountMenu={<span>account</span>}
        attentionComplete
        attentionItems={Array.from({ length: waiting }, (_, index) => ({ key: `item-${index}` })) as never}
        downloadedUpdate={null}
        onDecideAccessRequest={vi.fn()}
        onOpenAccessRequest={vi.fn()}
        workspace={person}
      />
      <Routes><Route element={<Location />} path="*" /></Routes>
    </MemoryRouter>
  </Tooltip.Provider></QueryClientProvider>);
}

describe('the navigation sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The Activity button counts from the feed on every tab, not only Activity's.
    api.getActivity.mockResolvedValue({ nextCursor: null, items: [] });
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [], pinned: [] });
    live.rows = [];
    localStorage.clear();
    useUiStore.getState().setSidebarSection('channels');
    useUiStore.getState().setThreadSort('recent');
    useUiStore.getState().setChannelSort('alphabetical');
    useUiStore.getState().setSidebarOpen(false);
    useUiStore.getState().setSheetAfterNavigation(false);
  });

  it('lists pinned Channels in the person’s order, then every other Channel A–Z, counting only new threads', () => {
    renderSidebar((client) => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [
        channel('zebra', 'Zebra'), channel('apple', 'Apple'), channel('outbound', 'Outbound'), channel('growth', 'Growth'),
        channel('zebra-empty', 'Zulu'),
      ] });
      client.setQueryData(PINS_QUERY_KEY, [
        { kind: 'channel', id: 'outbound', parentId: null },
        { kind: 'channel', id: 'growth', parentId: null },
      ]);
      client.setQueryData(CHANNEL_STATS_QUERY_KEY, [
        stats('apple', { threadCount: 4, newThreadCount: 2, latestAttentionSequenceNumber: 5, readThroughSequenceNumber: 3, firstUnreadSequenceNumber: 4, hasUnread: true }),
        // Two new rows, both private: more than this person may list.
        stats('growth', { threadCount: 0, newThreadCount: 2, latestAttentionSequenceNumber: 2, firstUnreadSequenceNumber: 1, hasUnread: true }),
        stats('zebra', { threadCount: 7, latestAttentionSequenceNumber: 7, readThroughSequenceNumber: 7 }),
        stats('outbound', { threadCount: 1, newThreadCount: 1, latestAttentionSequenceNumber: 1, firstUnreadSequenceNumber: 1, hasUnread: true }),
        // Its one new thread moved out again: nothing new is left to show.
        stats('zebra-empty', { threadCount: 0, latestAttentionSequenceNumber: 1, firstUnreadSequenceNumber: 1, hasUnread: true }),
      ]);
    });

    const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));
    expect(pinned.getAllByRole('link').map((row) => row.textContent))
      .toEqual(['Outbound1 new threadPinned, 1 of 2.', 'Growth2 new threadsPinned, 2 of 2.']);
    const all = within(screen.getByRole('region', { name: 'All channels' }));
    expect(all.getAllByRole('link').filter((row) => row.classList.contains('navigation-channel-row')).map((row) => row.textContent))
      .toEqual(['Apple2 new threads', 'Zebra', 'Zulu']);
  });

  it('reorders a pinned Channel from the keyboard and from its menu, not only by dragging', async () => {
    const pins = [
      { kind: 'channel' as const, id: 'outbound', parentId: null },
      { kind: 'channel' as const, id: 'growth', parentId: null },
    ];
    api.reorderPins.mockResolvedValue(pins);
    renderSidebar((client) => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound'), channel('growth', 'Growth')] });
      client.setQueryData(PINS_QUERY_KEY, pins);
    });
    const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));

    fireEvent.keyDown(pinned.getByRole('link', { name: /Growth/u }), { key: 'ArrowUp', altKey: true });
    expect(api.reorderPins).toHaveBeenLastCalledWith('channel', ['growth', 'outbound']);

    fireEvent.contextMenu(pinned.getByRole('link', { name: /Outbound/u }));
    expect(screen.queryByRole('menuitem', { name: 'Move up' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move down' }));
    expect(api.reorderPins).toHaveBeenLastCalledWith('channel', ['growth', 'outbound']);
  });

  it('keeps an empty Pinned section that says how to pin, and wakes it while a row is dragged', async () => {
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));
    const hint = pinned.getByText('Move a channel here to pin it').parentElement!;
    expect(hint).not.toHaveClass('is-armed');
    fireEvent.dragStart(screen.getByRole('link', { name: /Outbound/u }), { dataTransfer: { effectAllowed: 'all', setData: vi.fn() } });
    expect(hint).toHaveClass('is-armed');
    fireEvent.dragEnd(screen.getByRole('link', { name: /Outbound/u }));
    expect(hint).not.toHaveClass('is-armed');

    useUiStore.getState().setSidebarSection('threads');
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [] });
    expect(await within(await screen.findByRole('region', { name: 'Pinned threads' })).findByText('Move a thread here to pin it')).toBeInTheDocument();
  });

  it('gathers every pin in the Pinned tab, a section per kind, with nothing unpinned beside them', async () => {
    const pinnedPlan = thread('plan', 'Q4 plan');
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [thread('notes', 'Notes')], pinned: [pinnedPlan] });
    const pins = [
      { kind: 'channel' as const, id: 'outbound', parentId: null },
      { kind: 'thread' as const, id: 'plan', parentId: null },
    ];
    api.reorderPins.mockResolvedValue(pins);
    renderSidebar((client) => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound'), channel('growth', 'Growth')] });
      client.setQueryData(PINS_QUERY_KEY, pins);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }));

    expect(screen.getByRole('heading', { name: 'Pinned' })).toBeInTheDocument();
    const channels = within(screen.getByRole('region', { name: 'Pinned channels' }));
    expect(channels.getByText('Channels')).toBeInTheDocument();
    expect(channels.getAllByRole('link').map((row) => row.textContent)).toEqual(['OutboundPinned, 1 of 1.']);
    const threads = within(screen.getByRole('region', { name: 'Pinned threads' }));
    expect(threads.getByText('Threads')).toBeInTheDocument();
    await threads.findByRole('link', { name: /Q4 plan/u });
    expect(threadRows(threads)).toEqual([['Q4 plan', 'Outbound']]);
    expect(screen.queryByRole('region', { name: 'All channels' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'All threads' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Growth|Notes/u })).not.toBeInTheDocument();
  });

  it('hands focus to the row beside an unpinned row in the Pinned tab, and to the tab when none is left', async () => {
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [] });
    useUiStore.getState().setSidebarSection('pinned');
    const growth = { kind: 'channel' as const, id: 'growth', parentId: null };
    api.setPinned.mockResolvedValueOnce([growth]).mockResolvedValueOnce([]);
    renderSidebar((client) => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound'), channel('growth', 'Growth')] });
      client.setQueryData(PINS_QUERY_KEY, [{ kind: 'channel', id: 'outbound', parentId: null }, growth]);
    });

    fireEvent.contextMenu(screen.getByRole('link', { name: /Outbound/u }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /Outbound/u })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('link', { name: /Growth/u })).toHaveFocus());

    fireEvent.contextMenu(screen.getByRole('link', { name: /Growth/u }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /Growth/u })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pinned' })).toHaveFocus());
  });

  it('lists pinned artifacts on the Artifacts tab and opens one onto its panel in its thread', () => {
    useUiStore.getState().setSidebarSection('artifacts');
    renderSidebar((client) => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] });
      client.setQueryData(ARTIFACT_PINS_QUERY_KEY, [artifactPin('summary', 'Incident summary'), artifactPin('chart', 'Failure rate', 'image/png')]);
    });

    expect(screen.getByRole('heading', { name: 'Artifacts' })).toBeInTheDocument();
    const pinned = within(screen.getByRole('region', { name: 'Pinned artifacts' }));
    expect(pinned.getAllByRole('link').map((row) => [row.querySelector('.navigation-row-title')?.textContent, row.querySelector('.navigation-row-detail')?.textContent]))
      .toEqual([['Incident summary', 'Markdown · Launch'], ['Failure rate', 'Image · Launch']]);
    fireEvent.click(pinned.getByRole('link', { name: /Incident summary/u }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/launch');
    expect(JSON.parse(screen.getByTestId('location').dataset.state ?? 'null'))
      .toMatchObject({ openResource: { threadId: 'launch', resourceId: 'summary' } });
  });

  it('unpins an artifact from its row, and says how to pin one once none is left', async () => {
    useUiStore.getState().setSidebarSection('artifacts');
    api.setArtifactPinned.mockResolvedValue([]);
    renderSidebar((client) => client.setQueryData(ARTIFACT_PINS_QUERY_KEY, [artifactPin('summary', 'Incident summary')]));

    fireEvent.contextMenu(screen.getByRole('link', { name: /Incident summary/u }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));

    expect(api.setArtifactPinned).toHaveBeenCalledWith('summary', false, 'launch');
    expect(await screen.findByText('Pin an artifact to keep it here')).toBeInTheDocument();
  });

  it('counts pinned artifacts with an unseen version on the Artifacts and Pinned buttons, and marks their rows unread', () => {
    useUiStore.getState().setSidebarSection('artifacts');
    renderSidebar((client) => client.setQueryData(ARTIFACT_PINS_QUERY_KEY, [
      artifactPin('summary', 'Incident summary', 'text/markdown', { currentVersion: 3, unread: true }),
      artifactPin('chart', 'Failure rate', 'image/png'),
    ]));

    expect(screen.getByRole('img', { name: '1 updated' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '1 pinned with news' })).toBeInTheDocument();
    const rows = within(screen.getByRole('region', { name: 'Pinned artifacts' })).getAllByRole('link');
    expect(rows.map((row) => row.querySelector('[aria-label="Unread"]') !== null)).toEqual([true, false]);
  });

  it('says who updated a pinned artifact in Activity, and opens it onto the artifact in its thread', async () => {
    useUiStore.getState().setSidebarSection('activity');
    api.getActivity.mockResolvedValue({ nextCursor: null, items: [{
      id: 'artifact:summary:3', kind: 'artifact_updated', occurredAt: new Date().toISOString(),
      actorUserId: null, actorLabel: 'Rally', threadId: 'launch', threadTitle: 'Launch', breakout: null,
      artifact: { resourceId: 'summary', title: 'Incident summary', version: 3 }, channelIds: ['outbound'], unread: true,
    }] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    const row = await screen.findByRole('link', { name: /updated Incident summary in Launch/u });
    fireEvent.click(row);
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/launch');
    expect(JSON.parse(screen.getByTestId('location').dataset.state ?? 'null'))
      .toMatchObject({ openExpanded: true, openResource: { threadId: 'launch', resourceId: 'summary' } });
  });

  it('gathers pinned artifacts in the Pinned tab under their own heading', () => {
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [] });
    useUiStore.getState().setSidebarSection('pinned');
    renderSidebar((client) => client.setQueryData(ARTIFACT_PINS_QUERY_KEY, [artifactPin('summary', 'Incident summary')]));

    const artifacts = within(screen.getByRole('region', { name: 'Pinned artifacts' }));
    expect(artifacts.getByText('Artifacts')).toBeInTheDocument();
    expect(artifacts.getByRole('link', { name: /Incident summary/u })).toBeInTheDocument();
  });

  it('holds placeholders in the Pinned tab while its rows are read, rather than saying nothing is pinned', () => {
    api.getMyThreads.mockReturnValue(new Promise(() => undefined));
    useUiStore.getState().setSidebarSection('pinned');
    renderSidebar((client) => client.setQueryData(PINS_QUERY_KEY, [{ kind: 'thread', id: 'plan', parentId: null }]));
    for (const name of ['Pinned channels', 'Pinned threads']) {
      const section = screen.getByRole('region', { name });
      expect(section).toHaveAttribute('aria-busy', 'true');
      expect(within(section).queryByText(/to keep it here/u)).not.toBeInTheDocument();
    }
  });

  it('says how to pin from the Pinned tab when nothing is pinned, and gives a guest no Channels there', async () => {
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [] });
    useUiStore.getState().setSidebarSection('pinned');
    renderSidebar(
      (client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }),
      0,
      { person: { ...workspace, currentUser: { ...workspace.currentUser, accessClass: 'guest' } } },
    );
    expect(await within(screen.getByRole('region', { name: 'Pinned threads' })).findByText('Pin a thread to keep it here')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Pinned channels' })).not.toBeInTheDocument();
  });

  it('says why a pin did not save', async () => {
    api.setPinned.mockRejectedValue(new ApiError('limit', 409, 'pin_limit_reached'));
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.contextMenu(screen.getByRole('link', { name: /Outbound/u }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    expect(await screen.findByText('You’ve pinned as many items as Rally allows. Unpin one first.')).toBeInTheDocument();
  });

  it('locks a Personal Channel and a private Channel, and not an Organization-wide one', () => {
    renderSidebar((client) => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [
        channel('mine', 'Your Personal Channel', { scope: 'individual' }),
        channel('secret', 'Secret', { scope: 'personal' }),
        channel('general', 'General'),
      ] });
    });

    const all = within(screen.getByRole('region', { name: 'All channels' }));
    expect(all.getAllByRole('link').filter((row) => row.classList.contains('navigation-channel-row'))
      .map((row) => [row.textContent, within(row).queryByLabelText('Private') !== null]))
      .toEqual([['General', false], ['Secret', true], ['Your Personal Channel', true]]);
  });

  it('opens a Channel on its own route', () => {
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.click(screen.getByRole('link', { name: /Outbound/u }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound');
  });

  it('closes the phone sheet when a Channel is opened from it, and keeps it open across sections', () => {
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(screen.getByRole('button', { name: /Activity$/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('link', { name: /Outbound/u }));

    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the phone sheet once, after its own reset, when a navigation asked for it', () => {
    // A deep link into another organization remounts the sidebar and changes
    // the route; both reset the sheet, so the link asks for it this way.
    useUiStore.getState().setSheetAfterNavigation(true);
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');
    expect(useUiStore.getState().sheetAfterNavigation).toBe(false);

    // Spent: the next navigation closes the sheet as any other does.
    fireEvent.click(screen.getByRole('link', { name: /Outbound/u }));
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the phone sheet on Escape and hands focus back to its button', () => {
    renderSidebar(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    fireEvent.keyDown(window, { key: 'Escape' });

    const toggle = screen.getByRole('button', { name: 'Open navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  describe('at phone width, as a row of tabs', () => {
    const phoneWidth = (matches: boolean): void => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: matches && query === '(max-width: 640px)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      }));
    };
    afterEach(() => vi.unstubAllGlobals());
    /** The row's tiles, by label. */
    const tabs = (): string[] => [...screen.getByRole('navigation', { name: 'Sections' }).querySelectorAll('.navigation-rail-label')]
      .map((label) => label.textContent ?? '');

    it('folds the sections past the fourth into a More tab, whose menu carries their counts and opens one', async () => {
      phoneWidth(true);
      renderSidebar((client) => client.setQueryData(ARTIFACT_PINS_QUERY_KEY, [
        artifactPin('summary', 'Incident summary', 'text/markdown', { currentVersion: 3, unread: true }),
        artifactPin('chart', 'Failure rate', 'image/png', { currentVersion: 2, unread: true }),
      ]));
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

      expect(tabs()).toEqual(['Pinned', 'Channels', 'Threads', 'Activity', 'More']);
      const more = screen.getByRole('button', { name: /More$/u });
      expect(within(more).getByRole('img', { name: '2 updated' })).toHaveTextContent('2');
      expect(more).not.toHaveClass('is-active');
      expect(more).not.toHaveAttribute('aria-current');

      fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
      const artifacts = await screen.findByRole('menuitemradio', { name: /Artifacts/u });
      expect(artifacts).toHaveAttribute('aria-checked', 'false');
      expect(within(artifacts).getByRole('img', { name: '2 updated' })).toHaveTextContent('2');
      fireEvent.click(artifacts);

      expect(screen.getByRole('heading', { name: 'Artifacts' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Pinned artifacts' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /More$/u })).toHaveClass('is-active');
      // Current as a section's own tab is, so the pin reveal's focus fallback finds it.
      expect(screen.getByRole('button', { name: /More$/u })).toHaveAttribute('aria-current', 'page');
      // Switching sections does not navigate, so the sheet stays open on the list just picked.
      expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');

      fireEvent.pointerDown(screen.getByRole('button', { name: /More$/u }), { button: 0, ctrlKey: false });
      expect(await screen.findByRole('menuitemradio', { name: /Artifacts/u })).toHaveAttribute('aria-checked', 'true');
    });

    it('gives a guest, whose four sections all fit, no More tab', () => {
      phoneWidth(true);
      renderSidebar(() => undefined, 0, { person: { ...workspace, currentUser: { ...workspace.currentUser, accessClass: 'guest' } } });
      expect(tabs()).toEqual(['Pinned', 'Threads', 'Activity', 'Artifacts']);
      expect(screen.queryByRole('button', { name: /More$/u })).toBeNull();
    });

    it('draws every section as a tab on a wide window', () => {
      phoneWidth(false);
      renderSidebar(() => undefined);
      expect(tabs()).toEqual(['Pinned', 'Channels', 'Threads', 'Activity', 'Artifacts']);
      expect(screen.queryByRole('button', { name: /More$/u })).toBeNull();
    });
  });

  it('counts what is waiting on the Threads button', () => {
    renderSidebar(() => undefined, 3);
    expect(screen.getByRole('img', { name: '3 waiting' })).toHaveTextContent('3');
  });

  it('counts the Channels with threads this person has not seen on the Channels button', () => {
    renderSidebar((client) => {
      client.setQueryData(CHANNEL_STATS_QUERY_KEY, [
        stats('outbound', { hasUnread: true, newThreadCount: 3 }),
        stats('growth', { hasUnread: true, newThreadCount: 1 }),
        // Read past its news: the optimistic acknowledgement clears `hasUnread` first.
        stats('apple', { hasUnread: false, newThreadCount: 2 }),
        // Unread for a reply, not a new thread: the row says nothing new either.
        stats('kiwi', { hasUnread: true, newThreadCount: 0 }),
      ]);
    });
    expect(screen.getByRole('img', { name: '2 with new threads' })).toHaveTextContent('2');
  });

  it('gives a guest, who has no Channels section, no Channels count', () => {
    renderSidebar((client) => {
      client.setQueryData(CHANNEL_STATS_QUERY_KEY, [stats('outbound', { hasUnread: true, newThreadCount: 3 })]);
    }, 0, { person: { ...workspace, currentUser: { ...workspace.currentUser, accessClass: 'guest' } } });
    expect(screen.queryByRole('img', { name: /with new threads/u })).toBeNull();
  });

  it('counts pinned Channels with new threads and unread pinned threads and breakouts on the Pinned button', async () => {
    api.getMyThreads.mockResolvedValue({
      nextCursor: null,
      items: [thread('plan', 'Q4 plan', { hasUnread: true }), thread('notes', 'Notes', { hasUnread: true })],
      pinned: [
        thread('plan', 'Q4 plan', { hasUnread: true }),
        thread('quiet', 'Quiet', { hasUnread: false }),
        thread('site', 'Make a website', {
          kind: 'breakout', youAreMentioned: true,
          breakoutOf: { workstreamId: 'plan', substreamId: 'site', title: 'Q4 plan' },
        } as Partial<SpaceConversationSummary>),
      ],
    });
    renderSidebar((client) => {
      client.setQueryData(PINS_QUERY_KEY, [
        { kind: 'channel', id: 'outbound', parentId: null },
        { kind: 'channel', id: 'growth', parentId: null },
        { kind: 'thread', id: 'plan', parentId: null },
        { kind: 'thread', id: 'quiet', parentId: null },
        { kind: 'breakout', id: 'site', parentId: 'plan' },
      ]);
      client.setQueryData(CHANNEL_STATS_QUERY_KEY, [
        stats('outbound', { hasUnread: true, newThreadCount: 2 }),
        stats('growth', { hasUnread: false, newThreadCount: 0 }),
        // News, but not pinned: Channels counts it and Pinned does not.
        stats('apple', { hasUnread: true, newThreadCount: 1 }),
      ]);
    });

    // Outbound, Q4 plan and the mentioned breakout; not Quiet, Growth, or the unpinned Notes.
    expect(await screen.findByRole('img', { name: '3 pinned with news' })).toHaveTextContent('3');
    expect(screen.getByRole('img', { name: '2 with new threads' })).toBeInTheDocument();
  });

  it('counts unread Activity on the Activity button from any tab, and clears it on Mark all read', async () => {
    const at = new Date().toISOString();
    const row = (id: string, unread: boolean) => ({
      id, kind: 'added', occurredAt: at, actorUserId: 'maya', actorLabel: 'Maya K',
      threadId: 'plan', threadTitle: id, breakout: null, channelIds: [], unread,
    });
    api.getActivity.mockResolvedValue({ nextCursor: null, items: [row('one', true), row('two', true), row('three', false)] });
    renderSidebar(() => undefined);

    expect(await screen.findByRole('img', { name: '1 unread' })).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: /Activity$/u }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: /unread$/u })).toBeNull());
  });

  it('lists the person’s threads and breakouts, and opens a breakout beside its thread under that thread’s Channel', async () => {
    useUiStore.getState().setSidebarSection('threads');
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [
      thread('plan', 'Q4 plan', { lastActivityAt: '2026-10-02T00:00:00.000Z' }),
      thread('site', 'Make a website', {
        kind: 'breakout', lastActivityAt: '2026-10-03T00:00:00.000Z',
        breakoutOf: { workstreamId: 'plan', substreamId: 'site', title: 'Q4 plan' },
      }),
    ] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    const list = within(await screen.findByRole('region', { name: 'All threads' }));
    await waitFor(() => expect(threadRows(list)).toEqual([
      ['Make a website', 'Q4 planOutbound'],
      ['Q4 plan', 'Outbound'],
    ]));
    // A breakout's tile carries its thread, with the Channel nested on that;
    // a thread's carries the Channel itself.
    const breakoutRow = list.getByRole('link', { name: /Make a website/u });
    // A chevron, not a dot, separates the thread from its Channels.
    expect(within(breakoutRow).getByRole('img', { name: 'in' })).toHaveClass('navigation-row-detail-chevron');
    expect(breakoutRow.querySelectorAll('.identity-tile > .identity-tile-badge.is-circle > .identity-tile-badge.is-nested.is-squircle')).toHaveLength(1);
    const threadRow = list.getByRole('link', { name: /^Q4 plan/u });
    expect(threadRow.querySelectorAll('.identity-tile > .identity-tile-badge.is-squircle')).toHaveLength(1);
    expect(threadRow.querySelector('.is-nested')).toBeNull();
    // Each badge names what it stands for on hover, the nested one included.
    const nested = breakoutRow.querySelector<HTMLElement>('.identity-tile-badge.is-nested > .identity-tile-badge-fill');
    fireEvent.pointerMove(nested!, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Outbound');
    const parent = breakoutRow.querySelector<HTMLElement>('.identity-tile > .identity-tile-badge.is-circle > .identity-tile-badge-fill');
    fireEvent.pointerMove(parent!, { pointerType: 'mouse' });
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Q4 plan'));
    fireEvent.click(list.getByRole('link', { name: /Make a website/u }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/plan?substream=site');
  });

  describe('holding the open thread in Needs attention', () => {
    const items = [
      thread('fresh', 'Fresh unread', { hasUnread: true, lastActivityAt: '2026-10-04T00:00:00.000Z' }),
      thread('old', 'Old unread', { hasUnread: true, lastActivityAt: '2026-10-01T00:00:00.000Z' }),
      thread('new-read', 'New read', { lastActivityAt: '2026-10-05T00:00:00.000Z' }),
      thread('old-read', 'Old read', { lastActivityAt: '2026-10-02T00:00:00.000Z' }),
    ];
    const names = (): Array<string | null | undefined> => threadRows(within(screen.getByRole('region', { name: 'All threads' })))
      .map(([title]) => title);
    const seed = (client: QueryClient): void => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] });
    };

    beforeEach(() => {
      useUiStore.getState().setSidebarSection('threads');
      useUiStore.getState().setThreadSort('needs_you');
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items, pinned: [] });
    });

    it('leaves an already-read thread in its slot when opened, including on the initial route', async () => {
      renderSidebar(seed, 0, { route: '/channels/outbound/threads/old-read' });
      await waitFor(() => expect(names()).toEqual(['Fresh unread', 'Old unread', 'New read', 'Old read']));

      fireEvent.click(screen.getByRole('link', { name: /^New read/u }));
      expect(screen.getByTestId('location')).toHaveTextContent('/channels/outbound/threads/new-read');
      expect(names()).toEqual(['Fresh unread', 'Old unread', 'New read', 'Old read']);
    });

    it('keeps an unread thread in its slot after reading it, then releases it on navigation', async () => {
      // Deliver the same query-cache update the workspace socket publishes after a read.
      let cache!: QueryClient;
      renderSidebar((queryClient) => { cache = queryClient; seed(queryClient); });
      await waitFor(() => expect(names()).toEqual(['Fresh unread', 'Old unread', 'New read', 'Old read']));

      fireEvent.click(screen.getByRole('link', { name: /^Old unread/u }));
      cache.setQueryData(MY_THREADS_QUERY_KEY, {
        pages: [{ nextCursor: null, pinned: [], items: items.map((row) => row.id === 'old' ? { ...row, hasUnread: false } : row) }],
        pageParams: [null],
      });
      await waitFor(() => expect(screen.getByRole('link', { name: /^Old unread/u })).not.toHaveClass('is-unread'));
      expect(names()).toEqual(['Fresh unread', 'Old unread', 'New read', 'Old read']);

      fireEvent.click(screen.getByRole('link', { name: /^Fresh unread/u }));
      expect(names()).toEqual(['Fresh unread', 'New read', 'Old read', 'Old unread']);
    });

    it('respects an explicit sort change while the thread is open', async () => {
      renderSidebar(seed);
      await waitFor(() => expect(names()).toEqual(['Fresh unread', 'Old unread', 'New read', 'Old read']));
      fireEvent.click(screen.getByRole('link', { name: /^Old unread/u }));

      fireEvent.click(screen.getByRole('button', { name: 'Sorted by Needs attention. Sort by Recent' }));
      expect(names()).toEqual(['New read', 'Fresh unread', 'Old read', 'Old unread']);
      fireEvent.click(screen.getByRole('button', { name: 'Sorted by Recent. Sort by A–Z' }));
      expect(names()).toEqual(['Fresh unread', 'New read', 'Old read', 'Old unread']);
      fireEvent.click(screen.getByRole('button', { name: 'Sorted by A–Z. Sort by Needs attention' }));
      expect(names()).toEqual(['Fresh unread', 'Old unread', 'New read', 'Old read']);
    });
  });

  it('badges a breakout with its thread’s live appearance, not the one its listed page carried', async () => {
    useUiStore.getState().setSidebarSection('threads');
    live.rows = [thread('plan', 'Q4 plan', { appearance: { icon: null, color: 'red' } })];
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [
      thread('site', 'Make a website', {
        kind: 'breakout',
        breakoutOf: { workstreamId: 'plan', substreamId: 'site', title: 'Q4 plan', appearance: { icon: null, color: 'blue' } },
      }),
    ] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    const list = within(await screen.findByRole('region', { name: 'All threads' }));
    const row = await waitFor(() => list.getByRole('link', { name: /Make a website/u }));
    const fill = row.querySelector<HTMLElement>('.identity-tile > .identity-tile-badge.is-circle > .identity-tile-badge-fill');
    expect(fill?.style.background).toBe('var(--av-sys-color-project-ink-red)');
  });

  it('draws a breakout in its thread’s live colour, keeping its own icon, after its Channel is recoloured', async () => {
    useUiStore.getState().setSidebarSection('threads');
    live.rows = [thread('plan', 'Q4 plan', { appearance: { icon: null, color: 'purple' } })];
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [
      thread('site', 'Make a website', {
        kind: 'breakout',
        appearance: { icon: 'rocket', color: 'orange' },
        breakoutOf: { workstreamId: 'plan', substreamId: 'site', title: 'Q4 plan', appearance: { icon: null, color: 'orange' } },
      }),
    ] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    const list = within(await screen.findByRole('region', { name: 'All threads' }));
    const row = await waitFor(() => list.getByRole('link', { name: /Make a website/u }));
    const tile = row.querySelector<HTMLElement>('.identity-tile > .identity-tile-shape');
    expect(tile?.style.color).toBe('var(--av-sys-color-project-ink-purple)');
    expect(tile?.querySelector('svg')).toHaveClass('lucide-rocket');
  });

  it('folds replies, mentions and Rally completions into one row with the human preview', async () => {
    useUiStore.getState().setSidebarSection('activity');
    const now = Date.now();
    const base = { actorUserId: 'maya', actorLabel: 'Maya K', threadId: 'plan', threadTitle: 'Cold email',
      breakout: null, channelIds: ['outbound'], unread: true };
    api.getActivity.mockResolvedValue({ nextCursor: null, items: [
      { ...base, id: 'finish', kind: 'run_finished', occurredAt: new Date(now).toISOString(), actorUserId: null, actorLabel: 'Rally' },
      { ...base, id: 'message:reply', kind: 'new_message', occurredAt: new Date(now - 1000).toISOString(), preview: 'Need advil?', unreadMessageCount: 3 },
      { ...base, id: 'mention', kind: 'mentioned', occurredAt: new Date(now - 2000).toISOString() },
    ] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    const today = within(await screen.findByRole('region', { name: 'Today' }));
    expect(today.getAllByRole('link')).toHaveLength(1);
    expect(today.getByRole('link')).toHaveTextContent('Maya K replied in Cold email');
    expect(today.getByRole('link')).toHaveTextContent('Need advil?');
    expect(today.getByRole('link')).toHaveTextContent('3 new messages · @mention');
    expect(today.getByRole('link')).toHaveTextContent('Rally also finished');
    expect(today.getByRole('img', { name: 'Unread' })).toBeInTheDocument();
    expect(api.markActivitySeen).not.toHaveBeenCalled();
  });

  it('names who started a thread from the member directory when the row carries only their id', async () => {
    useUiStore.getState().setSidebarSection('activity');
    api.getActivity.mockResolvedValue({ nextCursor: null, items: [{
      id: 'started:plan', kind: 'thread_started', occurredAt: new Date().toISOString(), actorUserId: 'maya', actorLabel: '',
      threadId: 'plan', threadTitle: 'Q4 plan', breakout: null, channelIds: ['outbound'], unread: true,
    }] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    const today = within(await screen.findByRole('region', { name: 'Today' }));
    await waitFor(() => expect(today.getByRole('link')).toHaveTextContent('Maya K started Q4 plan'));
  });

  it('says what merged into what, and opens a merge where it landed', async () => {
    useUiStore.getState().setSidebarSection('activity');
    const now = new Date().toISOString();
    api.getActivity.mockResolvedValue({ nextCursor: null, items: [
      { id: 'merged:1', kind: 'merged', occurredAt: now, actorUserId: 'maya', actorLabel: '',
        threadId: 'plan', threadTitle: 'Q4 plan', breakout: { substreamId: 'b1', title: 'Sequence B' },
        channelIds: ['outbound'], unread: true },
      { id: 'merged:2', kind: 'merged', occurredAt: now, actorUserId: 'maya', actorLabel: '',
        threadId: 'plan', threadTitle: 'Q4 plan', breakout: null, mergedInto: { channelId: 'outbound', name: 'Outbound' },
        channelIds: ['outbound'], unread: true },
    ] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    const today = within(await screen.findByRole('region', { name: 'Today' }));
    const intoThread = await waitFor(() => today.getByRole('link', { name: /Maya K merged Sequence B into Q4 plan/u }));
    const intoChannel = today.getByRole('link', { name: /Maya K merged Q4 plan into Outbound/u });
    expect(intoThread.getAttribute('href')).not.toContain('b1');
    expect(intoChannel.getAttribute('href')).toBe('/channels/outbound');
  });

  it('badges Activity with Rally’s mark and each person’s own avatar', async () => {
    useUiStore.getState().setSidebarSection('activity');
    api.getWorkspaceMembers.mockResolvedValueOnce([{
      id: 'maya', name: 'Maya K', email: 'maya@rally.test', timezone: 'UTC',
      presentation: { color: 'orange', avatar: 'flower', initials: 'MK', revision: 1 },
    } as never]);
    const now = new Date().toISOString();
    api.getActivity.mockResolvedValue({ nextCursor: null, items: [
      { id: 'rally', kind: 'thread_started', occurredAt: now, actorUserId: null, actorLabel: 'Rally',
        threadId: 'plan', threadTitle: 'Q4 plan', breakout: null, channelIds: ['outbound'], unread: false },
      { id: 'maya', kind: 'thread_started', occurredAt: now, actorUserId: 'maya', actorLabel: 'Maya K',
        threadId: 'brief', threadTitle: 'Launch brief', breakout: null, channelIds: ['outbound'], unread: false },
    ] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    const today = within(await screen.findByRole('region', { name: 'Today' }));
    const badge = (name: RegExp) => today.getByRole('link', { name }).querySelector<HTMLElement>('.identity-tile > .identity-tile-badge.is-circle > .identity-tile-badge-fill');
    await waitFor(() => expect(badge(/Maya K started/u)?.querySelector('.personal-avatar')).toHaveClass('personal-avatar-flower'));
    expect(badge(/Maya K started/u)?.querySelector<HTMLElement>('.personal-avatar')?.style.color).toBe('var(--av-sys-color-project-orange)');
    expect(badge(/Maya K started/u)).toHaveTextContent('MK');
    expect(badge(/Rally started/u)?.querySelector('.avatar')).toHaveClass('avatar-rally');
    expect(badge(/Rally started/u)).toHaveTextContent('R');
  });

  it('groups Activity by day and keeps what is new unread while it is shown, focused or not', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useUiStore.getState().setSidebarSection('activity');
    const now = new Date();
    api.getActivity.mockResolvedValue({ nextCursor: null, items: [{
      id: 'event-1', kind: 'added', occurredAt: now.toISOString(), actorUserId: 'maya', actorLabel: 'Maya K',
      threadId: 'plan', threadTitle: 'Reply-handling playbook', breakout: null, channelIds: ['outbound'], unread: true,
    }] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));

    const today = within(await screen.findByRole('region', { name: 'Today' }));
    expect(today.getByRole('link')).toHaveTextContent('Maya K added you to Reply-handling playbook');
    expect(today.getByRole('img', { name: 'Unread' })).toBeInTheDocument();
    // Showing the tab in a focused window reads nothing; only Mark all read does.
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.markActivitySeen).not.toHaveBeenCalled();
    hasFocus.mockRestore();
  });

  it('marks a thread unread for new messages, a mention or never having opened it, and not for what its run is doing', async () => {
    useUiStore.getState().setSidebarSection('threads');
    api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [
      thread('new', 'New messages', { hasUnread: true }),
      thread('named', 'Named', { youAreMentioned: true }),
      thread('unseen', 'Never opened', { unseen: true }),
      thread('running', 'Running', { harnessStatus: 'running' }),
      thread('both', 'In two', { spaceIds: ['outbound', 'growth'] }),
    ] });
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound'), channel('growth', 'Growth')] }));

    const list = within(await screen.findByRole('region', { name: 'All threads' }));
    await waitFor(() => expect(list.getByRole('link', { name: /New messages/u })).toBeInTheDocument());
    const unread = (name: string): boolean => within(list.getByRole('link', { name: new RegExp(name, 'u') })).queryByRole('img', { name: 'Unread' }) !== null;
    expect(['New messages', 'Named', 'Never opened', 'Running', 'In two'].map(unread)).toEqual([true, true, true, false, false]);
    expect(threadRows(list).find(([title]) => title === 'In two')).toEqual(['In two', 'Outbound · Growth']);
    // A thread starts from a Channel's composer, so the header offers no New thread.
    expect(screen.queryByRole('button', { name: 'New thread' })).not.toBeInTheDocument();
  });

  it('opens New channel from the Channels header', () => {
    renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] }));
    fireEvent.click(screen.getByRole('button', { name: 'New channel' }));
    expect(screen.getByRole('dialog', { name: 'New channel' })).toBeInTheDocument();
  });

  describe('creating a Channel with an automatic color', () => {
    beforeEach(() => {
      vi.spyOn(Math, 'random');
      api.createSpace.mockResolvedValue(channel('growth', 'Growth'));
    });

    afterEach(() => {
      vi.mocked(Math.random).mockRestore();
    });

    it.each([
      { random: 0, colorKey: 'rose' },
      { random: 1 - Number.EPSILON, colorKey: 'pink' },
    ])('submits $colorKey for random value $random', async ({ random, colorKey }) => {
      vi.mocked(Math.random).mockReturnValue(random);
      renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [] }));
      fireEvent.click(screen.getByRole('button', { name: 'New channel' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Growth' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create channel' }));

      await waitFor(() => expect(api.createSpace).toHaveBeenCalledWith({ name: 'Growth', colorKey, scope: 'workspace' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New channel' })).not.toBeInTheDocument());
    });
  });

  describe('the Activity tab’s filters', () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);
    const item = (id: string, overrides: Record<string, unknown>) => ({
      id, kind: 'added', occurredAt: now.toISOString(), actorUserId: 'maya', actorLabel: 'Maya K',
      threadId: id, threadTitle: id, breakout: null, channelIds: ['outbound'], unread: false, ...overrides,
    });
    const seed = (client: QueryClient): void => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] });
    };

    beforeEach(() => {
      useUiStore.getState().setSidebarSection('activity');
      api.getActivity.mockImplementation(async (_cursor: string | null, only: string | null) => ({
        nextCursor: null,
        items: only === 'mentions'
          ? [item('Named here', { kind: 'mentioned' })]
          : [item('Fresh', { unread: true }), item('Old news', { occurredAt: earlier.toISOString() })],
      }));
    });

    it('shows only unread rows under Unread, and asks the server for mentions under Mentions', async () => {
      renderSidebar(seed);
      const titles = (): string[] => screen.queryAllByRole('link').filter((row) => row.classList.contains('activity-row'))
        .map((row) => row.querySelectorAll('strong')[1]?.textContent ?? '');
      await waitFor(() => expect(titles()).toEqual(['Fresh', 'Old news']));

      fireEvent.click(screen.getByRole('button', { name: 'Unread' }));
      expect(titles()).toEqual(['Fresh']);

      fireEvent.click(screen.getByRole('button', { name: 'Mentions' }));
      await waitFor(() => expect(titles()).toEqual(['Named here']));
      expect(api.getActivity).toHaveBeenCalledWith(null, 'mentions', expect.anything());
    });

    it('still lists what is unread under Unread after leaving the tab and coming back', async () => {
      // The server's answer follows its waterline: once marked seen, nothing is unread.
      let seen = false;
      api.markActivitySeen.mockImplementation(async () => { seen = true; });
      api.getActivity.mockImplementation(async () => ({ nextCursor: null, items: [item('Fresh', { unread: !seen })] }));
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [] });
      const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderSidebar(seed);
      await screen.findByRole('region', { name: 'Today' });
      // Looked at for longer than a read's debounce.
      window.dispatchEvent(new Event('focus'));
      await new Promise((resolve) => setTimeout(resolve, 400));

      fireEvent.click(screen.getByRole('button', { name: 'Threads' }));
      fireEvent.click(screen.getByRole('button', { name: /Activity$/u }));
      fireEvent.click(await screen.findByRole('button', { name: 'Unread' }));
      const today = within(await screen.findByRole('region', { name: 'Today' }));
      expect(today.getByRole('link')).toHaveTextContent('Fresh');
      expect(today.getByRole('img', { name: 'Unread' })).toBeInTheDocument();
      hasFocus.mockRestore();
    });

    it('clears every dot and moves the waterline on Mark all read', async () => {
      renderSidebar(seed);
      const today = within(await screen.findByRole('region', { name: 'Today' }));
      await waitFor(() => expect(today.getAllByRole('img', { name: 'Unread' })).toHaveLength(1));

      fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
      await waitFor(() => expect(today.queryAllByRole('img', { name: 'Unread' })).toEqual([]));
      expect(api.markActivitySeen).toHaveBeenCalledWith(now.toISOString());
    });

    it('reads the feed again when Mark all read fails, so its dots come back', async () => {
      api.markActivitySeen.mockRejectedValueOnce(new Error('offline'));
      renderSidebar(seed);
      const today = within(await screen.findByRole('region', { name: 'Today' }));
      await waitFor(() => expect(today.getAllByRole('img', { name: 'Unread' })).toHaveLength(1));
      const reads = api.getActivity.mock.calls.length;

      fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
      await waitFor(() => expect(api.getActivity.mock.calls.length).toBeGreaterThan(reads));
      await waitFor(() => expect(today.getAllByRole('img', { name: 'Unread' })).toHaveLength(1));
    });
  });

  describe('the Channels tab’s unread state and sort', () => {
    // Apple has never had a thread; Kiwi holds a thread that needs this
    // person; Mango has a placement this person has not seen; Zebra is the
    // most recently active and fully read.
    const seed = (client: QueryClient): void => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [
        channel('zebra', 'Zebra'), channel('apple', 'Apple'), channel('mango', 'Mango'), channel('kiwi', 'Kiwi', { attentionCount: 2 }),
      ] });
      client.setQueryData(CHANNEL_STATS_QUERY_KEY, [
        stats('zebra', { threadCount: 3, lastActivityAt: '2026-10-05T00:00:00.000Z', latestAttentionSequenceNumber: 3, readThroughSequenceNumber: 3 }),
        stats('mango', {
          threadCount: 1, newThreadCount: 1, lastActivityAt: '2026-10-03T00:00:00.000Z', latestAttentionSequenceNumber: 1,
          firstUnreadSequenceNumber: 1, hasUnread: true,
        }),
        stats('kiwi', { threadCount: 2, lastActivityAt: '2026-10-04T00:00:00.000Z', latestAttentionSequenceNumber: 2, readThroughSequenceNumber: 2 }),
      ]);
    };
    const names = (): Array<string | null | undefined> => within(screen.getByRole('region', { name: 'All channels' }))
      .getAllByRole('link')
      .filter((row) => row.classList.contains('navigation-channel-row'))
      .map((row) => row.querySelector('.navigation-row-title')?.textContent);

    it('marks only an unread Channel, with its count of new threads and a dot', () => {
      renderSidebar(seed);
      const mango = within(screen.getByRole('link', { name: /Mango/u }));
      expect(mango.getByText('1 new thread')).toBeInTheDocument();
      expect(mango.getByRole('img', { name: 'Unread' })).toBeInTheDocument();
      expect(screen.getAllByText(/new thread/u)).toHaveLength(1);
      expect(screen.getAllByRole('img', { name: 'Unread' })).toHaveLength(1);
    });

    it('cycles A–Z, Recent and Needs attention from the heading', () => {
      renderSidebar(seed);
      expect(names()).toEqual(['Apple', 'Kiwi', 'Mango', 'Zebra']);

      fireEvent.click(screen.getByRole('button', { name: 'Sorted by A–Z. Sort by Recent' }));
      expect(names()).toEqual(['Zebra', 'Kiwi', 'Mango', 'Apple']);

      fireEvent.click(screen.getByRole('button', { name: 'Sorted by Recent. Sort by Needs attention' }));
      expect(names()).toEqual(['Mango', 'Kiwi', 'Zebra', 'Apple']);
      expect(screen.getByRole('button', { name: 'Sorted by Needs attention. Sort by A–Z' })).toBeInTheDocument();
    });

    it('keeps the chosen order when the sidebar is drawn again', () => {
      const first = renderSidebar(seed);
      fireEvent.click(screen.getByRole('button', { name: 'Sorted by A–Z. Sort by Recent' }));
      first.unmount();

      renderSidebar(seed);
      expect(screen.getByRole('button', { name: 'Sorted by Recent. Sort by Needs attention' })).toBeInTheDocument();
      expect(names()).toEqual(['Zebra', 'Kiwi', 'Mango', 'Apple']);
    });
  });
  describe('list motion', () => {
    const animate = vi.fn((element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      void element; void keyframes; void options;
      return { cancel: vi.fn(), onfinish: null, oncancel: null };
    });
    const measure = Element.prototype.getBoundingClientRect;

    // `animate` is deleted rather than restored because jsdom never defined
    // it; the measurement jsdom does define goes back as it was.
    beforeEach(() => {
      animate.mockClear();
      Element.prototype.animate = function animateStub(
        this: Element,
        keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
        options?: number | KeyframeAnimationOptions,
      ): Animation {
        return animate(this, keyframes as Keyframe[], options as KeyframeAnimationOptions) as unknown as Animation;
      };
      // jsdom lays nothing out: rows and headings sit one slot apart in
      // document order under the scroll box.
      Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
        const scroll = this.closest('.sidebar-scroll');
        const index = scroll === null || scroll === this
          ? 0
          : [...scroll.querySelectorAll('[data-motion-key]')].indexOf(this);
        const top = index * 48;
        return { top, left: 8, right: 288, bottom: top + 48, width: 280, height: 48, x: 8, y: top, toJSON: () => ({}) };
      };
    });

    afterEach(() => {
      delete (Element.prototype as Partial<Element>).animate;
      Element.prototype.getBoundingClientRect = measure;
    });

    function playedOn(key: string): { element: HTMLElement; keyframes: Keyframe[] } | undefined {
      const call = animate.mock.calls.find(([element]) => (element as HTMLElement).dataset.motionKey === key);
      return call ? { element: call[0] as HTMLElement, keyframes: call[1] } : undefined;
    }

    const fruit = { waterline: 1, items: [channel('apple', 'Apple'), channel('mango', 'Mango'), channel('zebra', 'Zebra')] };

    it('moves a pinned Channel up into Pinned, and shifts the rows it passed', async () => {
      api.setPinned.mockResolvedValue([{ kind: 'channel', id: 'zebra', parentId: null }]);
      renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, fruit));

      fireEvent.contextMenu(screen.getByRole('link', { name: /Zebra/u }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));
      await pinned.findByRole('link', { name: /Zebra/u });

      // Zebra rises three slots, from last under All channels to first under
      // Pinned: the row the Pinned section now renders is the one that plays.
      const moved = playedOn('channel:zebra');
      expect(screen.getByRole('region', { name: 'Pinned channels' })).toContainElement(moved!.element);
      expect(moved!.keyframes[0]).toEqual(expect.objectContaining({ transform: 'translate(0px, 144px)' }));
      expect(playedOn('channel:apple')?.keyframes).toEqual([{ transform: 'translate(0px, -48px)' }, { transform: 'translate(0px, 0px)' }]);
    });

    it('pins a row dragged into Pinned at the slot held open for it', async () => {
      api.setPinned.mockResolvedValue(['apple', 'mango', 'zebra'].map((id) => ({ kind: 'channel', id, parentId: null })));
      api.reorderPins.mockResolvedValue(['apple', 'zebra', 'mango'].map((id) => ({ kind: 'channel', id, parentId: null })));
      renderSidebar((client) => {
        client.setQueryData(SPACES_QUERY_KEY, fruit);
        client.setQueryData(PINS_QUERY_KEY, [
          { kind: 'channel', id: 'apple', parentId: null },
          { kind: 'channel', id: 'mango', parentId: null },
        ]);
      });
      const section = screen.getByRole('region', { name: 'Pinned channels' });
      const zebra = within(screen.getByRole('region', { name: 'All channels' })).getByRole('link', { name: /Zebra/u });
      fireEvent.dragStart(zebra, { dataTransfer: { effectAllowed: 'all', setData: vi.fn() } });

      // The Pinned heading is slot 0, Apple 1 and Mango 2: a pointer past
      // Apple's middle and short of Mango's holds the slot between them.
      const over = createEvent.dragOver(section, { dataTransfer: { dropEffect: 'none' } });
      Object.defineProperty(over, 'clientY', { value: 100 });
      fireEvent(section, over);
      const ghost = section.querySelector('.is-pin-ghost');
      expect(ghost).toHaveTextContent('Zebra');
      expect([...section.querySelectorAll('.navigation-channel-row')].map((row) => row.textContent?.slice(0, 5)))
        .toEqual(['Apple', 'Zebra', 'Mango']);

      fireEvent.drop(section);
      // A new pin is appended, so the slot it was dropped in is saved after.
      await waitFor(() => expect(api.reorderPins).toHaveBeenCalledWith('channel', ['apple', 'zebra', 'mango']));
      expect(api.setPinned).toHaveBeenCalledWith('channel', 'zebra', true, undefined);
      await waitFor(() => expect(within(section).getAllByRole('link').filter((row) => row.classList.contains('navigation-channel-row'))
        .map((row) => row.textContent?.slice(0, 5))).toEqual(['Apple', 'Zebra', 'Mango']));
      expect(section.querySelector('.is-pin-ghost')).toBeNull();
    });

    it('lets a row pinned by dragging be unpinned back into its list', async () => {
      const pinnedList = [{ kind: 'channel' as const, id: 'zebra', parentId: null }];
      api.setPinned.mockResolvedValueOnce(pinnedList).mockResolvedValueOnce([]);
      renderSidebar((client) => client.setQueryData(SPACES_QUERY_KEY, fruit));
      const section = screen.getByRole('region', { name: 'Pinned channels' });
      const all = within(screen.getByRole('region', { name: 'All channels' }));
      fireEvent.dragStart(all.getByRole('link', { name: /Zebra/u }), { dataTransfer: { effectAllowed: 'all', setData: vi.fn() } });
      fireEvent.dragOver(section, { dataTransfer: { dropEffect: 'none' } });
      fireEvent.drop(section);
      const pinnedZebra = await within(section).findByRole('link', { name: /Zebra/u });

      fireEvent.contextMenu(pinnedZebra);
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
      expect(await all.findByRole('link', { name: /Zebra/u })).toBeInTheDocument();
      expect(within(section).queryByRole('link', { name: /Zebra/u })).not.toBeInTheDocument();
    });

    it('holds the dragged row, and drops it in the slot laid out under the pointer', () => {
      const pins = fruit.items.map((item) => ({ kind: 'channel' as const, id: item.id, parentId: null }));
      api.reorderPins.mockResolvedValue(pins);
      renderSidebar((client) => {
        client.setQueryData(SPACES_QUERY_KEY, fruit);
        client.setQueryData(PINS_QUERY_KEY, pins);
      });
      const pinned = within(screen.getByRole('region', { name: 'Pinned channels' }));
      const zebra = pinned.getByRole('link', { name: /Zebra/u });
      fireEvent.dragStart(zebra, { dataTransfer: { effectAllowed: 'all' } });
      expect(zebra).toHaveAttribute('data-motion-hold');

      // The event reaches Apple, but the pointer is in Mango's laid-out slot
      // (the Pinned heading is slot 0, Apple 1, Mango 2): a row drawn there
      // mid-motion is not the slot's owner.
      // jsdom has no DragEvent, so the pointer's position is set by hand.
      const apple = pinned.getByRole('link', { name: /Apple/u });
      const over = createEvent.dragOver(apple);
      Object.defineProperty(over, 'clientY', { value: 100 });
      fireEvent(apple, over);
      fireEvent.drop(zebra);
      expect(api.reorderPins).toHaveBeenLastCalledWith('channel', ['apple', 'zebra', 'mango']);
    });
  });

  describe('what the old sidebar did', () => {
    const plan = thread('00000000-0000-4000-8000-000000000020', 'Q4 plan', { spaceIds: ['outbound'] });
    const seedThreads = (client: QueryClient): void => {
      client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound')] });
    };

    const scrollIntoView = vi.fn();

    // Installed and removed in hooks, so a failing assertion cannot leak the
    // stub into later tests. jsdom never defined it, so it is deleted.
    beforeEach(() => {
      useUiStore.getState().setSidebarSection('threads');
      warmedThreads.length = 0;
      scrollIntoView.mockClear();
      Element.prototype.scrollIntoView = scrollIntoView;
    });

    afterEach(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });

    it('gives a guest no Channels section, even when Channels was the section last chosen', async () => {
      useUiStore.getState().setSidebarSection('channels');
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      renderSidebar(seedThreads, 0, { person: { ...workspace, currentUser: { ...workspace.currentUser, accessClass: 'guest' } } });
      expect(screen.queryByRole('button', { name: 'Channels' })).not.toBeInTheDocument();
      expect(await screen.findByRole('region', { name: 'All threads' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'All channels' })).not.toBeInTheDocument();
    });

    it('draws rows as links, so a modified click can open one in a new tab', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      renderSidebar(seedThreads);
      expect(await screen.findByRole('link', { name: /Q4 plan/u })).toHaveAttribute('href', `/channels/outbound/threads/${plan.id}`);
    });

    it('starts the open measurement on a plain click, and not for the open thread clicked again', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      renderSidebar(seedThreads);
      fireEvent.click(await screen.findByRole('link', { name: /Q4 plan/u }));
      expect(screen.getByTestId('location')).toHaveTextContent(`/channels/outbound/threads/${plan.id}`);
      expect(telemetry.markWorkstreamFeedOpenStarted).toHaveBeenCalledWith(plan.id, 'recent', 'retained_pair', expect.any(Number), 'lease-1');
      expect(telemetry.markWorkstreamNavigation).toHaveBeenCalledWith(plan.id, false);
      expect(telemetry.markSurfaceEntrypoint).toHaveBeenCalledWith('sidebar_recent');

      fireEvent.click(screen.getByRole('link', { name: /Q4 plan/u }));
      expect(telemetry.markWorkstreamFeedOpenStarted).toHaveBeenCalledTimes(1);
    });

    it('asks for the thread expanded on every open, the open row clicked again included', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      renderSidebar(seedThreads);
      fireEvent.click(await screen.findByRole('link', { name: /Q4 plan/u }));
      const location = screen.getByTestId('location');
      expect(location).toHaveAttribute('data-state', '{"openExpanded":true}');
      const first = location.getAttribute('data-key');

      fireEvent.click(screen.getByRole('link', { name: /Q4 plan/u }));
      expect(screen.getByTestId('location')).toHaveAttribute('data-state', '{"openExpanded":true}');
      expect(screen.getByTestId('location').getAttribute('data-key')).not.toBe(first);
    });

    it('warms a thread’s socket while the pointer rests on its row', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      renderSidebar(seedThreads);
      const row = await screen.findByRole('link', { name: /Q4 plan/u });
      expect(warmedThreads).toContain(plan.id);
      fireEvent.pointerEnter(row);
      expect(warmup.onPointerEnter).toHaveBeenCalled();
      fireEvent.pointerLeave(row);
      expect(warmup.onPointerLeave).toHaveBeenCalled();
    });

    it('reports a thread pin once it saves', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      api.setPinned.mockResolvedValue([{ kind: 'thread', id: plan.id, parentId: null }]);
      renderSidebar(seedThreads);
      fireEvent.contextMenu(await screen.findByRole('link', { name: /Q4 plan/u }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      await waitFor(() => expect(telemetry.reportTelemetryProductIntent).toHaveBeenCalledWith({
        kind: 'workstream_action_completed', workstreamId: plan.id, action: 'pin', visibility: 'public', origin: 'ad_hoc', pinned: true,
      }));
    });

    it('scrolls to a row a pin moved, and gives it focus when the move left focus nowhere', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan] });
      api.setPinned.mockResolvedValue([{ kind: 'thread', id: plan.id, parentId: null }]);
      renderSidebar(seedThreads);
      fireEvent.contextMenu(await screen.findByRole('link', { name: /Q4 plan/u }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      const pinned = within(screen.getByRole('region', { name: 'Pinned threads' }));
      const row = await pinned.findByRole('link', { name: /Q4 plan/u });
      await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(row));
      expect(row).toHaveFocus();
    });

    it('shows a timer on a thread with a wake-up coming', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [{
        ...plan, nextPendingWakeup: { dueAt: '2026-10-13T09:00:00.000Z', promptPreview: 'Check the replies' },
      }] });
      renderSidebar(seedThreads);
      expect(await screen.findByRole('img', { name: /^Active timer\. Next: .+\. Check the replies$/u })).toBeInTheDocument();
    });

    it('holds a thread Rally is still naming in place of its provisional title', async () => {
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [{
        ...plan, title: 'can you plan q4 for me', titleStatus: 'naming', createdAt: new Date().toISOString(),
      }] });
      renderSidebar(seedThreads);
      const list = within(await screen.findByRole('region', { name: 'All threads' }));
      expect(await list.findByText('Rally is choosing a name')).toBeInTheDocument();
      expect(list.queryByText('can you plan q4 for me')).not.toBeInTheDocument();
    });

    it('draws placeholder rows while the first page loads', () => {
      api.getMyThreads.mockReturnValue(new Promise(() => undefined));
      renderSidebar(seedThreads);
      expect(screen.getByRole('region', { name: 'All threads' })).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('region', { name: 'All threads' }).querySelectorAll('.skeleton-row').length).toBeGreaterThan(0);
    });

    it('loads pages until a thread opened from a link is listed, then scrolls it into view', async () => {
      const linked = thread('00000000-0000-4000-8000-000000000099', 'Linked thread');
      api.getMyThreads
        .mockResolvedValueOnce({ nextCursor: 'page-2', items: [plan] })
        .mockResolvedValueOnce({ nextCursor: null, items: [linked] });
      markDeepLinkWorkstreamNavigation(linked.id);
      renderSidebar(seedThreads, 0, { route: `/channels/outbound/threads/${linked.id}` });
      const row = await screen.findByRole('link', { name: /Linked thread/u });
      expect(api.getMyThreads).toHaveBeenLastCalledWith('page-2', expect.anything());
      await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(row));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    });

    it('counts a pinned breakout’s place past the pinned threads, and offers no reorder when neither kind can move', async () => {
      const site = thread('00000000-0000-4000-8000-000000000030', 'Make a website', {
        kind: 'breakout', breakoutOf: { workstreamId: plan.id, substreamId: 'site', title: 'Q4 plan' },
      });
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan, site] });
      renderSidebar((client) => {
        seedThreads(client);
        client.setQueryData(PINS_QUERY_KEY, [
          { kind: 'thread', id: plan.id, parentId: null },
          { kind: 'breakout', id: site.id, parentId: plan.id },
        ]);
      });
      const pinned = within(screen.getByRole('region', { name: 'Pinned threads' }));
      expect(await pinned.findByText('Pinned, 1 of 2.')).toBeInTheDocument();
      expect(pinned.getByText('Pinned, 2 of 2.')).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Pinned threads' })).not.toHaveAttribute('aria-describedby');
    });

    it('does not save an older drop’s order over a pin written after it', async () => {
      let answer!: (list: unknown) => void;
      api.setPinned
        .mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }))
        .mockResolvedValueOnce([
          { kind: 'thread', id: plan.id, parentId: null },
          { kind: 'thread', id: '00000000-0000-4000-8000-000000000031', parentId: null },
        ]);
      const other = thread('00000000-0000-4000-8000-000000000031', 'Hiring loop');
      const first = thread('00000000-0000-4000-8000-000000000032', 'Launch notes');
      api.getMyThreads.mockResolvedValue({ nextCursor: null, items: [plan, other, first] });
      renderSidebar((client) => {
        seedThreads(client);
        client.setQueryData(PINS_QUERY_KEY, [{ kind: 'thread', id: first.id, parentId: null }]);
      });
      // Drop Q4 plan above Launch notes, then pin Hiring loop from its menu
      // while the drop's pin is still in flight.
      const section = screen.getByRole('region', { name: 'Pinned threads' });
      const list = within(await screen.findByRole('region', { name: 'All threads' }));
      fireEvent.dragStart(await list.findByRole('link', { name: /Q4 plan/u }), { dataTransfer: { effectAllowed: 'all', setData: vi.fn() } });
      const over = createEvent.dragOver(section, { dataTransfer: { dropEffect: 'none' } });
      Object.defineProperty(over, 'clientY', { value: -1 });
      fireEvent(section, over);
      fireEvent.drop(section);
      fireEvent.contextMenu(list.getByRole('link', { name: /Hiring loop/u }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
      await waitFor(() => expect(api.setPinned).toHaveBeenCalledTimes(2));

      answer([{ kind: 'thread', id: first.id, parentId: null }, { kind: 'thread', id: plan.id, parentId: null }]);
      await waitFor(() => expect(telemetry.reportTelemetryProductIntent).toHaveBeenCalledWith(expect.objectContaining({ workstreamId: plan.id, action: 'pin' })));
      expect(api.reorderPins).not.toHaveBeenCalled();
    });

    it('tells a screen reader how to reorder, once for the section', () => {
      useUiStore.getState().setSidebarSection('channels');
      renderSidebar((client) => {
        client.setQueryData(SPACES_QUERY_KEY, { waterline: 1, items: [channel('outbound', 'Outbound'), channel('growth', 'Growth')] });
        client.setQueryData(PINS_QUERY_KEY, [
          { kind: 'channel', id: 'outbound', parentId: null },
          { kind: 'channel', id: 'growth', parentId: null },
        ]);
      });
      expect(screen.getByRole('region', { name: 'Pinned channels' }))
        .toHaveAccessibleDescription('Hold Alt and press the up or down arrow to move a pinned channel.');
    });
  });
});
