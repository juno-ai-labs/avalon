import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  recordActivityEvents: vi.fn(async () => undefined),
  clientFeatureFlags: vi.fn(),
  getConnections: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getConversation: vi.fn(),
  attachResource: vi.fn(),
}));
const session = vi.hoisted(() => ({ current: null as unknown }));
const retainedSocket = vi.hoisted(() => vi.fn());

vi.mock('../lib/collaboration-session', async (importOriginal) => {
  const actual = await importOriginal<typeof CollaborationSessionModule>();
  return {
    useOptionalCollaborationSession: () => null,
    useCollaborationSession: () => ({ api, session: session.current }),
    useShellCapabilities: () => actual.shellCapabilities({ host: 'desktop', session: session.current as ClientSession | null }),
  };
});

vi.mock('../lib/use-client-feature-flags', () => ({
  useClientFeatureFlags: () => ({ data: {} }),
}));

vi.mock('../lib/workstream-socket-pool', () => ({
  useWorkstreamSocketOpenContext: () => () => ({}),
  useRetainedWorkstreamSocket: retainedSocket,
}));

vi.mock('../lib/workspace-socket', () => ({
  useWorkspaceSocket: () => ({ presenceUserIdsByWorkstream: {} }),
  useOptionalWorkspaceSocket: () => null,
}));

vi.mock('../lib/use-file-attachments', () => ({
  useFileAttachments: () => ({
    addFiles: vi.fn(),
    attachments: [],
    consume: vi.fn(),
    error: undefined,
    ready: [],
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    uploading: false,
  }),
}));

vi.mock('../lib/use-transcript-follow', () => ({
  TRANSCRIPT_END_SLACK: 24,
  useTranscriptFollow: () => ({
    atEnd: true,
    isFollowing: () => true,
    onScroll: vi.fn(),
    onWheel: vi.fn(),
    release: vi.fn(),
    scrollTo: vi.fn(),
    scrollToEnd: vi.fn(),
  }),
}));


import { WorkstreamScreen } from './workstream';
import { useUiStore } from '../lib/ui-store';
import type { WorkstreamBoot, WorkstreamDetail, WorkstreamResource } from '../lib/types';
import type * as CollaborationSessionModule from '../lib/collaboration-session';
import type { ClientSession } from '@rally/contracts/client-session';
import { asSubstreamId } from '@rally/contracts';
import type { SharedNavigationDirectory } from '@rally/contracts/scope-grants';
import { conversationDirectoryQueryKey } from '../lib/conversation-directory';
import { desktopBridge } from '../lib/platform';

const channelId = '00000000-0000-7000-8000-000000000801';
const breakoutId = asSubstreamId('00000000-0000-7000-8000-000000000802');

function boot(id: string, title: string, resources: WorkstreamResource[] = [], text?: string): WorkstreamBoot {
  return {
    id,
    title,
    titleStatus: 'settled',
    harnessStatus: 'completed',
    scope: 'personal',
    lastActivityAt: '2026-08-26T14:00:00.000Z',
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
    createdAt: '2026-08-26T14:00:00.000Z',
    participants: [],
    viewers: [],
    resources,
    connections: [],
    backgroundTasks: [],
    openElicitations: [],
    transcript: {
      snapshotId: `snapshot-${id}`,
      snapshotThrough: text ? 1 : 0,
      eventSequence: 0,
      snapshotAtUtc: '2026-08-26T14:00:00.000Z',
      unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: text ? [{
        purpose: 'latest',
        requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [agentTurn(text)],
        activities: [],
        pluginRuns: [],
      }] : [],
      activities: [],
      activeActivities: [],
      pluginRuns: [],
      activeTurns: [],
      pendingInputs: [],
    },
  };
}

const site: WorkstreamResource = {
  id: 'market-map',
  title: 'Market map',
  resourceType: 'generated_site',
  provider: 'rally_generated',
  refreshSupported: false,
  watchEnabled: false,
  watchStatus: 'unsupported',
  contentAvailable: true,
  currentVersion: 1,
  relationshipType: 'generated',
  direction: 'artifact',
};
const reply = 'Updated the site.\n\n![Market map](resource://market-map)\n';

function agentTurn(text: string): WorkstreamBoot['transcript']['ranges'][number]['turns'][number] {
  return {
    transcriptSequence: 1,
    turnId: 'turn-agent-1',
    entryKind: 'conversation',
    actor: 'assistant',
    authorUserId: null,
    authorSnapshot: null,
    attentionOrdinal: 1,
    createdAtUtc: '2026-08-26T14:00:00.000Z',
    revision: 1,
    blocks: [{ type: 'text', blockId: 'turn-agent-1:text:0', blockIndex: 0, text, streaming: false, messageType: 'text' }],
    activityId: null,
  };
}

function seed(queryClient: QueryClient, key: readonly unknown[], transcriptKey: readonly unknown[], value: WorkstreamBoot): void {
  const { transcript, ...detail } = value;
  queryClient.setQueryData<WorkstreamDetail>(key, detail);
  queryClient.setQueryData(transcriptKey, { ...transcript, snapshotId: `snapshot-${transcriptKey.join(':')}` });
}

function renderScreen({ breakout, directory }: { breakout: boolean; directory?: SharedNavigationDirectory }): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  if (directory) queryClient.setQueryData(conversationDirectoryQueryKey(undefined), directory);
  seed(queryClient, ['workstream', channelId], ['ordered-transcript', channelId],
    boot(channelId, 'Channel', breakout ? [] : [site], breakout ? undefined : reply));
  if (breakout) {
    seed(queryClient, ['substream-workstream', channelId, breakoutId], ['substream-ordered-transcript', channelId, breakoutId],
      boot(channelId, 'Breakout', [site], reply));
  }
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/workstreams/${channelId}${breakout ? `?substream=${breakoutId}` : ''}`]}>
          <Routes>
            <Route element={<WorkstreamScreen />} path="/workstreams/:id" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

async function openCardMenu(): Promise<void> {
  // The channel sidebar lists the resource under the same name; the card is the transcript's.
  const buttons = await screen.findAllByRole('button', { name: 'Open Market map' });
  fireEvent.contextMenu(buttons.find((button) => button.classList.contains('citation-card'))!);
}

describe('attaching a breakout artifact to its channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.current = { user: { id: 'member', email: 'member@example.test' }, workspace: { id: 'workspace', region: 'global', accessClass: 'member' } };
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    useUiStore.setState({ railOpen: false, railVariant: 'context', inspector: null });
    api.getWorkspaceMembers.mockResolvedValue([]);
    api.getConnections.mockResolvedValue([]);
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      requestSnapshot: vi.fn(),
      retryOpening: vi.fn(),
      sendReady: true,
      state: 'connected',
      workspaceSocketState: 'connected',
      suggestions: [],
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('attaches to the parent channel from a breakout, then shows the item disabled', async () => {
    const attached = boot(channelId, 'Channel', [{ ...site, relationshipType: 'attachment', direction: 'source' }]);
    api.attachResource.mockResolvedValue({ ...attached, transcript: undefined });
    renderScreen({ breakout: true });
    await openCardMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Attach to thread' }));
    await waitFor(() => expect(api.attachResource).toHaveBeenCalledWith(channelId, site.id));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    await openCardMenu();
    await waitFor(async () => expect(await screen.findByRole('menuitem', { name: 'Attach to thread' }))
      .toHaveAttribute('aria-disabled', 'true'));
  });

  it('sends one attach while the first is still in flight', async () => {
    api.attachResource.mockReturnValue(new Promise(() => undefined));
    renderScreen({ breakout: true });
    await openCardMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Attach to thread' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    await openCardMenu();
    const item = await screen.findByRole('menuitem', { name: 'Attach to thread' });
    await waitFor(() => expect(item).toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(item);
    expect(api.attachResource).toHaveBeenCalledOnce();
  });

  it('offers no menu in the channel itself', async () => {
    renderScreen({ breakout: false });
    await openCardMenu();
    expect(screen.queryByRole('menuitem', { name: 'Attach to thread' })).toBeNull();
  });

  it('offers no menu to somebody whose conversations leave Main out, who has no channel to attach to', async () => {
    session.current = { user: { id: 'guest', email: 'guest@example.test' }, workspace: { id: 'workspace', region: 'global', accessClass: 'guest' } };
    renderScreen({ breakout: true, directory: {
      spaces: [],
      workstreams: [{
        parentId: channelId, title: 'Channel', scope: 'personal', archived: false,
        conversations: [{ substreamId: breakoutId, title: 'Breakout', scope: 'personal', archived: false }],
      }],
    } });
    await openCardMenu();
    expect(screen.queryByRole('menuitem', { name: 'Attach to thread' })).toBeNull();
  });
});

describe('importing a conversation as a breakout from the thread composer', () => {
  const openBrowserImport = vi.fn(async () => undefined);
  /** The Mac app's bridge: the browser fallback's methods, plus the import window only the app has. */
  const stubMacBridge = (): void => { vi.stubGlobal('rally', { ...desktopBridge(), openBrowserImport }); };
  beforeEach(() => {
    vi.clearAllMocks();
    session.current = { user: { id: 'member', email: 'member@example.test' }, workspace: { id: 'workspace', region: 'global', accessClass: 'member' } };
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    useUiStore.setState({ railOpen: false, railVariant: 'context', inspector: null });
    api.getWorkspaceMembers.mockResolvedValue([]);
    api.getConnections.mockResolvedValue([]);
    retainedSocket.mockReturnValue({
      suggestions: [],
      activeCompaction: null, createMessage: vi.fn(), requestSnapshot: vi.fn(), retryOpening: vi.fn(),
      sendReady: true, state: 'connected', workspaceSocketState: 'connected',
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function composerMenu(): Promise<string[]> {
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Composer actions' }), { button: 0, ctrlKey: false });
    return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
  }

  it('opens the import window aimed at a new breakout of this thread', async () => {
    stubMacBridge();
    renderScreen({ breakout: false });
    expect(await composerMenu()).toEqual(['Attach files', 'Import from Claude or ChatGPT']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import from Claude or ChatGPT' }));
    expect(openBrowserImport).toHaveBeenCalledWith({ spaces: [], breakout: { workstreamId: channelId, title: 'Channel' } });
  });

  it('shows the entry disabled where there is no embedded browser to import through', async () => {
    renderScreen({ breakout: false });
    await composerMenu();
    expect(screen.getByRole('menuitem', { name: 'Import from Claude or ChatGPT' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('offers a guest no import, which the API refuses them', async () => {
    stubMacBridge();
    session.current = { user: { id: 'guest', email: 'guest@example.test' }, workspace: { id: 'workspace', region: 'global', accessClass: 'guest' } };
    renderScreen({ breakout: false });
    expect(await composerMenu()).toEqual(['Attach files']);
  });

  it('offers no import in a breakout’s composer, which cannot hold breakouts of its own', async () => {
    stubMacBridge();
    renderScreen({ breakout: true });
    const reply = await screen.findByRole('textbox', { name: 'Reply in Breakout' });
    const breakoutComposer = within(reply.closest<HTMLElement>('.workstream-composer')!);
    fireEvent.pointerDown(breakoutComposer.getByRole('button', { name: 'Composer actions' }), { button: 0, ctrlKey: false });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Attach files']);
  });
});
