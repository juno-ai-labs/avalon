import { useSidekickActivity } from './use-sidekick-activity';
import {
  ClientFeatureFlagsSchema,
  asSpaceId,
  asSubstreamId,
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSPACE_SYNC_TOPICS,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkstreamSchema,
} from '@rally/contracts';
import type { ConversationAccessPreview, SpaceDirectory } from '@rally/contracts';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { onlineManager, QueryClient, QueryClientProvider, useQuery, type InfiniteData } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect, type JSX, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceConversationSummary, WorkstreamSummary } from './types';
import { applyBreakoutAppearanceReceipt, reconcileThreadNavigationRows, type WorkstreamChildDirectory } from './channel-viewer-state';
import { mapWorkstreamSummary } from './api';
import { WorkspaceSocketProvider, useWorkspaceSocket } from './workspace-socket';
import { holdCachedWorkstreamArchive, setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import { conversationCacheKey, conversationSlice } from './conversation-cache';
import { clearAllLocalCache } from './local-cache';
import { LOCAL_CACHE_WRITE_COALESCE_MS } from './local-cache-mirror';
import { LocalCacheScopeProvider } from './local-cache-scope';
import { organizationUsageQueryKey, usageCacheSlice, useOrganizationUsage, type OrganizationUsageApi } from './organization-usage';
import { requestSocketTicket, SOCKET_TICKET_REQUEST_TIMEOUT_MS } from './socket-ticket-request';
import { WORKSPACE_SOCKET_OPEN_TIMEOUT_MS } from '@rally/contracts/workspace-reach-watch';
import { DIRECTORY_CACHE_KEY, workspaceDirectorySlice } from './workspace-directory-cache';
import { useMergeChannels } from './use-merge-channels';
import { ConversationAccessRequest } from '../components/conversation-access-request';
import { CONVERSATION_ACCESS_RECOVERY_QUERY_KEY, refreshConversationAccessPreviews } from './access-requests';
import { MY_THREADS_QUERY_KEY, SPACES_QUERY_KEY, type ThreadNavigationPage } from './sidebar-list-store';

import type * as TelemetryModule from './telemetry';
import type {
  WorkspaceSyncPublication,
  WorkspaceSyncRelayEvent,
  WorkspaceSyncSourceSnapshot,
  WorkspaceConversationViewRelayRequest,
} from '../../common/workspace-sync-relay';

const reportTelemetryProductIntent = vi.hoisted(() => vi.fn());
const applicationFocus = vi.hoisted(() => ({
  foregrounded: false,
  listeners: new Set<(foregrounded: boolean) => void>(),
}));
vi.mock('./telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof TelemetryModule>(),
  reportTelemetryProductIntent,
}));
const powerState = vi.hoisted(() => ({
  listeners: new Set<(state: 'suspended' | 'resumed') => void>(),
}));
const syncRelay = vi.hoisted(() => ({
  published: [] as WorkspaceSyncPublication[],
  listeners: new Set<(event: WorkspaceSyncRelayEvent) => void>(),
  snapshot: { revision: 0, source: null } as WorkspaceSyncSourceSnapshot,
  requests: [] as WorkspaceConversationViewRelayRequest[],
}));
vi.mock('./platform', () => ({
  // This store-ordering suite exercises the browser-shaped transport. The
  // Electron broker contract has its own adapter and main-process tests.
  desktopServicesAvailable: () => false,
  desktopBridge: () => ({
    getApplicationForegroundState: async () => applicationFocus.foregrounded,
    onApplicationForegroundChanged: (listener: (foregrounded: boolean) => void) => {
      applicationFocus.listeners.add(listener);
      return () => applicationFocus.listeners.delete(listener);
    },
    onPowerStateChanged: (listener: (state: 'suspended' | 'resumed') => void) => {
      powerState.listeners.add(listener);
      return () => powerState.listeners.delete(listener);
    },
    publishWorkspaceSync: async (publication: WorkspaceSyncPublication) => {
      syncRelay.published.push(publication);
    },
    requestWorkspaceConversationView: async (request: WorkspaceConversationViewRelayRequest) => {
      syncRelay.requests.push(request);
    },
    getWorkspaceSyncSource: async () => syncRelay.snapshot,
    onWorkspaceSyncRelayed: (listener: (event: WorkspaceSyncRelayEvent) => void) => {
      syncRelay.listeners.add(listener);
      return () => syncRelay.listeners.delete(listener);
    },
  }),
}));

/** What main would deliver to the consuming window. */
function relayToConsumer(event: WorkspaceSyncRelayEvent): void {
  act(() => {
    for (const listener of syncRelay.listeners) listener(event);
  });
}

function setApplicationForeground(foregrounded: boolean): void {
  applicationFocus.foregrounded = foregrounded;
  for (const listener of applicationFocus.listeners) listener(foregrounded);
}

/** What main relays from `powerMonitor`. */
function setPowerState(state: 'suspended' | 'resumed'): void {
  act(() => {
    for (const listener of powerState.listeners) listener(state);
  });
}

/** Every `realtime_socket_state` this test reported, in order. */
function socketTelemetry(): unknown[] {
  return reportTelemetryProductIntent.mock.calls
    .map(([intent]) => intent as { kind: string })
    .filter((intent) => intent.kind === 'realtime_socket_state');
}

function handshakeTelemetry(): Array<{ kind: string; attemptId: string; phase: string }> {
  return reportTelemetryProductIntent.mock.calls
    .map(([intent]) => intent as { kind: string; attemptId: string; phase: string })
    .filter((intent) => intent.kind === 'workspace_socket_handshake');
}

function summary(overrides: Partial<WorkstreamSummary> = {}): WorkstreamSummary {
  return {
    id: '00000000-0000-7000-8000-000000000002',
    title: 'Before the change',
    titleStatus: 'settled',
    harnessStatus: 'running',
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: '2026-08-17T19:00:00.000Z',
    scope: 'workspace',
    nextPendingWakeup: null,
    pinPosition: null,
    participantUserIds: [],
    participantExtraCount: 0,
    spaceIds: [],
    ...overrides,
  };
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly send = vi.fn();

  constructor(readonly url: string | URL, readonly protocols?: string | string[]) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    // As a browser does: closing a socket that never opened fails it first.
    const failed = this.readyState === FakeWebSocket.CONNECTING;
    this.readyState = FakeWebSocket.CLOSED;
    if (failed) this.dispatchEvent(new Event('error'));
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // A test that fires the window's `offline` event leaves React Query's
  // global online state offline, and every later query would pause.
  onlineManager.setOnline(true);
  reportTelemetryProductIntent.mockClear();
  applicationFocus.foregrounded = false;
  applicationFocus.listeners.clear();
  powerState.listeners.clear();
  syncRelay.published = [];
  syncRelay.listeners.clear();
  syncRelay.snapshot = { revision: 0, source: null };
  syncRelay.requests = [];
  FakeWebSocket.instances = [];
  vi.restoreAllMocks();
});

function initialSidebarFrame() {
  return {
    type: 'workspace_sync', eventId: '00000000-0000-7000-8000-000000000008',
    waterline: 8, occurredAt: '2026-08-17T20:00:00.000Z',
    topics: ['workstream_directory'], reason: 'initial',
    sidebar: {
      workstreams: { directoryWaterline: 8, nextCursor: null, stateVersions: [], items: [] },
      automations: { waterline: 0, items: [] }, notes: { waterline: 0, items: [] },
    },
  };
}

describe('WorkspaceSocketProvider', () => {
  it('relays consumer previews, retries on publisher handover, and cancels obsolete requests', async () => {
    const workspaceId = '00000000-0000-7000-8000-000000000001';
    const parentId = '00000000-0000-7000-8000-000000000020';
    syncRelay.snapshot = { revision: 1, source: { region: 'global', workspaceId, state: 'connected' } };
    const queryClient = new QueryClient();
    const receive = vi.fn();
    let requestView: ReturnType<typeof useWorkspaceSocket>['requestConversationView'] | undefined;
    function Preview(): null {
      requestView = useWorkspaceSocket().requestConversationView;
      return null;
    }
    const getWorkspaceSocketTicket = vi.fn();
    const rendered = render(<QueryClientProvider client={queryClient}>
      <WorkspaceSocketProvider relay="consume" region="global" workspaceId={workspaceId} api={{ getWorkspaceSocketTicket }}>
        <Preview />
      </WorkspaceSocketProvider>
    </QueryClientProvider>);
    await flushPromises();
    let cancel = () => {};
    act(() => { cancel = requestView!(parentId, '0', receive); });
    const request = syncRelay.requests[0]!;
    expect(request).toMatchObject({ type: 'conversation_view_request', parentId, substreamId: '0' });
    expect(getWorkspaceSocketTicket).not.toHaveBeenCalled();
    relayToConsumer({ type: 'source', revision: 2, source: { region: 'global', workspaceId, state: 'connecting' } });
    expect(syncRelay.requests.filter((value) => value.type === 'conversation_view_request')).toHaveLength(2);
    const reply = { type: 'conversation_view_response' as const, region: 'global' as const, workspaceId,
      event: { type: 'workspace_conversation_view' as const, requestId: request.requestId, parentId, substreamId: asSubstreamId('0'), view: null } };
    relayToConsumer(reply);
    expect(receive).toHaveBeenCalledWith(reply.event);
    act(() => { cancel = requestView!(parentId, '0', receive); });
    const cancelledRequest = syncRelay.requests.at(-1)!;
    act(() => cancel());
    expect(syncRelay.requests.at(-1)).toMatchObject({ type: 'conversation_view_cancel', requestId: cancelledRequest.requestId });
    relayToConsumer({ ...reply, event: { ...reply.event, requestId: cancelledRequest.requestId } });
    expect(receive).toHaveBeenCalledTimes(1);
    rendered.unmount();
    queryClient.clear();
  });

  it('serves a consumer request through the publishing window socket', async () => {
    const workspaceId = '00000000-0000-7000-8000-000000000001';
    const parentId = '00000000-0000-7000-8000-000000000020';
    const requestId = '00000000-0000-7000-8000-000000000021';
    const queryClient = new QueryClient();
    const rendered = render(<QueryClientProvider client={queryClient}>
      <WorkspaceSocketProvider relay="publish" region="global" workspaceId={workspaceId}
        api={{ getWorkspaceSocketTicket: vi.fn().mockResolvedValue({
          ticket: 'ticket-1', expiresAt: '2026-08-26T21:00:00.000Z', socketUrl: 'ws://localhost:8787/workspace/socket',
        }) }}>{null}</WorkspaceSocketProvider>
    </QueryClientProvider>);
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({ ...initialSidebarFrame(), conversationViews: true }));
    relayToConsumer({ type: 'conversation_view_request', region: 'global', workspaceId, requestId, parentId, substreamId: '0' });
    const sent = socket.send.mock.calls.map(([frame]) => JSON.parse(String(frame)) as Record<string, unknown>)
      .find((frame) => frame.type === 'conversation_view');
    expect(sent).toMatchObject({ parentId, substreamId: '0' });
    act(() => socket.message({ ...sent, type: 'workspace_conversation_view', view: null }));
    expect(syncRelay.published.at(-1)).toEqual({ type: 'conversation_view_response', region: 'global', workspaceId,
      event: { type: 'workspace_conversation_view', requestId, parentId, substreamId: '0', view: null } });
    rendered.unmount();
    queryClient.clear();
  });

  it.each([false, true])('requests previews only when advertised (%s) and ignores cancelled replies', async (supported) => {
    const queryClient = new QueryClient();
    const receive = vi.fn();
    let cancel = () => undefined;
    const parentId = '00000000-0000-7000-8000-000000000020';
    function Preview(): null {
      const { requestConversationView } = useWorkspaceSocket();
      useEffect(() => {
        const stop = requestConversationView(parentId, '0', receive);
        cancel = () => { stop(); return undefined; };
        return stop;
      }, [requestConversationView]);
      return null;
    }
    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global" workspaceId="00000000-0000-7000-8000-000000000001"
          api={{ getWorkspaceSocketTicket: vi.fn().mockResolvedValue({
            ticket: 'ticket-1', expiresAt: '2026-08-26T21:00:00.000Z',
            socketUrl: 'ws://localhost:8787/workspace/socket',
          }) }}>
          <Preview />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({ ...initialSidebarFrame(), ...(supported ? { conversationViews: true } : {}) }));
    const sent = socket.send.mock.calls.map(([frame]) => JSON.parse(String(frame)) as Record<string, unknown>);
    expect(sent.filter((frame) => frame.type === 'conversation_view')).toEqual(supported ? [{
      type: 'conversation_view', requestId: expect.any(String), parentId, substreamId: '0',
    }] : []);
    const request = sent.find((frame) => frame.type === 'conversation_view');
    act(() => cancel());
    if (request) act(() => socket.message({ ...request, type: 'workspace_conversation_view', view: null }));
    expect(receive).not.toHaveBeenCalled();
    rendered.unmount();
    queryClient.clear();
  });

  it('reports app and channel foreground separately and receives viewer-scoped presence', async () => {
    applicationFocus.foregrounded = true;
    const documentFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    const workstreamId = '00000000-0000-7000-8000-000000000002';

    function Probe(): JSX.Element {
      const workspaceSocket = useWorkspaceSocket();
      useEffect(() => {
        workspaceSocket.setForegroundWorkstreamId(workstreamId);
        return () => workspaceSocket.setForegroundWorkstreamId(null);
      }, [workspaceSocket.setForegroundWorkstreamId]);
      return <div>{(workspaceSocket.presenceUserIdsByWorkstream[workstreamId] ?? []).join(',')}</div>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <Probe />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('set_presence'));
    act(() => socket.message({ type: 'future_workspace_event', waterline: 999 }));
    act(() => socket.message({
      future: true,
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000008',
      waterline: 0,
      occurredAt: '2026-08-26T20:00:00.000Z',
      topics: ['workspace_profile'],
      reason: 'initial',
    }));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'set_presence',
      revision: 1,
      applicationState: 'foreground',
      foregroundWorkstreamId: workstreamId,
    }));

    act(() => socket.message({
      type: 'workspace_presence',
      occurredAt: '2026-08-26T20:00:00.000Z',
      workstreamId,
      userIds: ['00000000-0000-7000-8000-000000000003'],
    }));
    expect(await screen.findByText('00000000-0000-7000-8000-000000000003')).toBeInTheDocument();

    documentFocus.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('blur')));
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({
      type: 'set_presence',
      revision: 2,
      applicationState: 'foreground',
      foregroundWorkstreamId: null,
    }));

    act(() => setApplicationForeground(false));
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({
      type: 'set_presence',
      revision: 3,
      applicationState: 'background',
      foregroundWorkstreamId: null,
    }));
  });

  it('drops snapshots on route changes and fails malformed foreground ids closed', async () => {
    applicationFocus.foregrounded = true;
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const queryClient = new QueryClient();
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000002';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000004';
    let setForegroundWorkstreamId: ((workstreamId: string | null) => void) | null = null;

    function Probe(): JSX.Element {
      const workspaceSocket = useWorkspaceSocket();
      setForegroundWorkstreamId = workspaceSocket.setForegroundWorkstreamId;
      return <div>{Object.values(workspaceSocket.presenceUserIdsByWorkstream).flat().join(',')}</div>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket: vi.fn(async () => ({
            url: 'wss://api.rally.test/socket/workspaces/workspace-1',
            ticket: 'workspace-ticket',
            protocols: socketTicketProtocols('workspace-ticket'),
          })) }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <Probe />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => setForegroundWorkstreamId!(firstWorkstreamId));
    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000008',
      waterline: 0,
      occurredAt: '2026-08-26T20:00:00.000Z',
      topics: ['workspace_profile'],
      reason: 'initial',
    }));
    act(() => socket.message({
      type: 'workspace_presence',
      occurredAt: '2026-08-26T20:00:00.000Z',
      workstreamId: firstWorkstreamId,
      userIds: ['00000000-0000-7000-8000-000000000003'],
    }));
    expect(await screen.findByText('00000000-0000-7000-8000-000000000003')).toBeInTheDocument();

    act(() => setForegroundWorkstreamId!(secondWorkstreamId));
    expect(screen.queryByText('00000000-0000-7000-8000-000000000003')).not.toBeInTheDocument();
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({
      type: 'set_presence',
      revision: 2,
      applicationState: 'foreground',
      foregroundWorkstreamId: secondWorkstreamId,
    }));

    act(() => setForegroundWorkstreamId!('not-a-workstream-id'));
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({
      type: 'set_presence',
      revision: 3,
      applicationState: 'foreground',
      foregroundWorkstreamId: null,
    }));
  });

  it('retains a socket nudge across collection until a waiting screen mounts, then releases it with the socket', async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onRetry = vi.fn();
    const api = {
      getWorkspaceSocketTicket: async () => ({
        url: 'wss://api.rally.test/socket/workspaces/workspace-1', ticket: 'workspace-ticket',
        protocols: socketTicketProtocols('workspace-ticket'),
      }),
      conversationAccessPreview: async () => ({
        kind: 'channel' as const, title: 'Launch plan', appearance: null, markId: 'thread-1', access: 'open' as const,
      }),
      requestConversationAccess: async () => undefined,
    };
    const contents = (waiting: boolean) => <QueryClientProvider client={queryClient}>
      <WorkspaceSocketProvider region="global" api={api} workspaceId="00000000-0000-7000-8000-000000000001">
        {waiting && <ConversationAccessRequest api={api} parentId="thread-1" substreamId="0"
          fallback={<p>Thread unavailable</p>} onRetry={onRetry} />}
      </WorkspaceSocketProvider>
    </QueryClientProvider>;
    const mounted = render(contents(false));
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    socket.send.mockImplementation((message: string) => {
      if (message === 'ping') queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: 'pong' })));
    });
    act(() => { socket.open(); socket.message(initialSidebarFrame()); });
    await flushPromises();
    // The unobserved entry's normal five-minute collection timer is almost
    // due. A setQueryData write alone does not restart that timer.
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 - 1_000); });
    act(() => socket.message({ type: 'workspace_reach_changed', occurredAt: '2026-10-22T00:00:00.000Z',
      userIds: ['00000000-0000-7000-8000-000000000003'] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    mounted.rerender(contents(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('Opening thread…');
    mounted.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 + 1); });
    expect(queryClient.getQueryData(CONVERSATION_ACCESS_RECOVERY_QUERY_KEY)).toBeUndefined();
  });

  it('waits for an offline-paused preview to resume before consuming its access nudge', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await refreshConversationAccessPreviews(queryClient);
    const key = ['conversation-access-preview', 'thread-1', '0'];
    const open: ConversationAccessPreview = {
      kind: 'channel', title: 'Launch plan', appearance: null, markId: 'thread-1', access: 'open',
    };
    queryClient.setQueryData(key, { ...open, recoveryVersion: 1 });
    await queryClient.invalidateQueries({ queryKey: key, refetchType: 'none' });
    onlineManager.setOnline(false);
    let finishPreview!: (preview: ConversationAccessPreview) => void;
    const pending = new Promise<ConversationAccessPreview>((resolve) => { finishPreview = resolve; });
    const api = { conversationAccessPreview: vi.fn(() => pending), requestConversationAccess: async () => undefined };
    const onRetry = vi.fn();
    render(<QueryClientProvider client={queryClient}>
      <ConversationAccessRequest api={api} parentId="thread-1" substreamId="0"
        fallback={<p>Thread unavailable</p>} onRetry={onRetry} />
    </QueryClientProvider>);
    await flushPromises();
    expect(queryClient.getQueryState(key)?.fetchStatus).toBe('paused');
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    act(() => onlineManager.setOnline(true));
    await vi.waitFor(() => expect(api.conversationAccessPreview).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await act(async () => { finishPreview(open); await pending; });
    await vi.waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1), { timeout: 5_000 });
  });

  it.each(['before-query', 'before-mount'] as const)('recovers a nudge recorded %s without retrying again after a failed reopen', async (timing) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ['conversation-access-preview', 'thread-1', '0'];
    const open: ConversationAccessPreview = {
      kind: 'channel', title: 'Launch plan', appearance: null, markId: 'thread-1', access: 'open',
    };
    if (timing === 'before-mount') queryClient.setQueryData(key, { ...open, recoveryVersion: 0 });
    await refreshConversationAccessPreviews(queryClient);
    let finishPreview!: (preview: ConversationAccessPreview) => void;
    const pending = new Promise<ConversationAccessPreview>((resolve) => { finishPreview = resolve; });
    const api = {
      conversationAccessPreview: vi.fn(() => pending), requestConversationAccess: async () => undefined,
    };
    const onRetry = vi.fn();
    const contents = <QueryClientProvider client={queryClient}>
      <ConversationAccessRequest api={api} parentId="thread-1" substreamId="0"
        fallback={<p>Thread unavailable</p>} onRetry={onRetry} />
    </QueryClientProvider>;
    const mounted = render(contents);
    await flushPromises();
    expect(api.conversationAccessPreview).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    await act(async () => { finishPreview(open); await pending; });
    await vi.waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(screen.getByRole('status').textContent).toBe('Opening thread…');
    mounted.unmount();
    onRetry.mockClear();
    render(contents);
    await flushPromises();
    expect(screen.getByText('Thread unavailable')).toBeTruthy();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each(['refused', 'failed'] as const)('waits for a fresh preview instead of retrying cached open access when the check is %s', async (outcome) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let finishPreview!: (preview: ConversationAccessPreview) => void;
    let failPreview!: (error: Error) => void;
    const pending = new Promise<ConversationAccessPreview>((resolve, reject) => { finishPreview = resolve; failPreview = reject; });
    const open: ConversationAccessPreview = {
      kind: 'channel', title: 'Launch plan', appearance: null, markId: 'thread-1', access: 'open',
    };
    const api = {
      getWorkspaceSocketTicket: async () => ({
        url: 'wss://api.rally.test/socket/workspaces/workspace-1', ticket: 'workspace-ticket',
        protocols: socketTicketProtocols('workspace-ticket'),
      }),
      conversationAccessPreview: vi.fn().mockResolvedValueOnce(open).mockImplementation(() => pending),
      requestConversationAccess: async () => undefined,
    };
    const onRetry = vi.fn();
    render(<QueryClientProvider client={queryClient}>
      <WorkspaceSocketProvider region="global" api={api} workspaceId="00000000-0000-7000-8000-000000000001">
        <ConversationAccessRequest api={api} parentId="thread-1" substreamId="0"
          fallback={<p>Thread unavailable</p>} onRetry={onRetry} />
      </WorkspaceSocketProvider>
    </QueryClientProvider>);
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.message({ type: 'workspace_reach_changed', occurredAt: '2026-10-22T00:00:00.000Z',
        userIds: ['00000000-0000-7000-8000-000000000003'] });
    });
    await vi.waitFor(() => expect(api.conversationAccessPreview).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => {
      if (outcome === 'failed') failPreview(new Error('access check failed'));
      else finishPreview({ ...open, access: 'requestable' });
      await pending.catch(() => undefined);
    });
    if (outcome === 'failed') await screen.findByText('Thread unavailable');
    else await screen.findByRole('button', { name: 'Request access' });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each(['reach', 'reconnect'] as const)('replaces an initial preview still pending when a %s nudge arrives', async (change) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let finishStalePreview!: (preview: ConversationAccessPreview) => void;
    const pending = new Promise<ConversationAccessPreview>((resolve) => { finishStalePreview = resolve; });
    const open: ConversationAccessPreview = {
      kind: 'channel', title: 'Launch plan', appearance: null, markId: 'thread-1', access: 'open',
    };
    const api = {
      getWorkspaceSocketTicket: async () => ({
        url: 'wss://api.rally.test/socket/workspaces/workspace-1', ticket: 'workspace-ticket',
        protocols: socketTicketProtocols('workspace-ticket'),
      }),
      conversationAccessPreview: vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(open),
      requestConversationAccess: async () => undefined,
    };
    const onRetry = vi.fn();
    render(<QueryClientProvider client={queryClient}>
      <WorkspaceSocketProvider region="global" api={api} workspaceId="00000000-0000-7000-8000-000000000001">
        <ConversationAccessRequest api={api} parentId="thread-1" substreamId="0"
          fallback={<p>Thread unavailable</p>} onRetry={onRetry} />
      </WorkspaceSocketProvider>
    </QueryClientProvider>);
    await flushPromises();
    expect(api.conversationAccessPreview).toHaveBeenCalledTimes(1);
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.message(change === 'reconnect' ? initialSidebarFrame() : {
        type: 'workspace_reach_changed', occurredAt: '2026-10-22T00:00:00.000Z',
        userIds: ['00000000-0000-7000-8000-000000000003'],
      });
    });
    // The new request must observe the grant without waiting for the old
    // response, whose pre-grant decision cannot be allowed back into the cache.
    await vi.waitFor(() => expect(api.conversationAccessPreview).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    await vi.waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await act(async () => { finishStalePreview({ ...open, access: 'requestable' }); await pending; });
    expect(screen.getByRole('status').textContent).toBe('Opening thread…');
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each([
    { closeCode: 1006, label: 'retryable transport loss' },
    { closeCode: WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, label: 'permanent access loss' },
  ])('clears ephemeral presence after $label', async ({ closeCode }) => {
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000002';

    function Probe(): JSX.Element {
      const workspaceSocket = useWorkspaceSocket();
      return <div>{(workspaceSocket.presenceUserIdsByWorkstream[workstreamId] ?? []).join(',')}</div>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket: vi.fn(async () => ({
            url: 'wss://api.rally.test/socket/workspaces/workspace-1',
            ticket: 'workspace-ticket',
            protocols: socketTicketProtocols('workspace-ticket'),
          })) }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <Probe />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'workspace_presence',
      occurredAt: '2026-08-26T20:00:00.000Z',
      workstreamId,
      userIds: ['00000000-0000-7000-8000-000000000003'],
    }));
    expect(await screen.findByText('00000000-0000-7000-8000-000000000003')).toBeInTheDocument();

    act(() => socket.close(closeCode));
    expect(screen.queryByText('00000000-0000-7000-8000-000000000003')).not.toBeInTheDocument();
  });

  it('notifies the session owner when the active organization revokes access', async () => {
    const queryClient = new QueryClient();
    const onAccessRevoked = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket: vi.fn(async () => ({
            url: 'wss://api.rally.test/socket/workspaces/workspace-1',
            ticket: 'workspace-ticket',
            protocols: socketTicketProtocols('workspace-ticket'),
          })) }}
          onAccessRevoked={onAccessRevoked}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div>workspace</div>
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE));

    expect(onAccessRevoked).toHaveBeenCalledOnce();
  });

  it.each([
    {
      closeCode: WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
      status: 403,
      code: 'workspace_access_revoked',
      message: 'You can no longer access this organization.',
      telemetryCause: 'access_revoked',
    },
    {
      closeCode: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
      status: 401,
      code: 'workspace_session_inactive',
      message: 'Your session is no longer active. Sign in again.',
      telemetryCause: 'server_closed',
    },
    {
      closeCode: WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
      status: 400,
      code: 'workspace_socket_invalid_message',
      message: 'Rally could not complete this action because its realtime command was invalid. Restart the app and try again.',
      telemetryCause: 'server_closed',
    },
  ])('reports close code $closeCode truthfully and does not reconnect', async ({
    closeCode,
    status,
    code,
    message,
    telemetryCause,
  }) => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    let listWorkstreams: ReturnType<typeof useWorkspaceSocket>['listWorkstreams'] | null = null;
    function Probe(): null {
      const workspaceSocket = useWorkspaceSocket();
      useEffect(() => {
        listWorkstreams = workspaceSocket.listWorkstreams;
      }, [workspaceSocket.listWorkstreams]);
      return null;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <Probe />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    reportTelemetryProductIntent.mockClear();
    let result: Promise<unknown> | null = null;
    act(() => {
      result = listWorkstreams!({ limit: 10, includeSystem: false });
    });

    act(() => socket.close(closeCode));
    await expect(result).rejects.toMatchObject({ status, code, message });
    expect(socketTelemetry()).toEqual([{
      kind: 'realtime_socket_state',
      socket: 'workspace',
      state: 'stopped',
      cause: telemetryCause,
      attempts: 'zero',
    }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('keeps one organization socket, subscribes durably, and invalidates every organization surface', async () => {
    const queryClient = new QueryClient();
    const recommendationKey = ['recommended-sidekicks', 'idle-workstream'];
    queryClient.setQueryData(recommendationKey, []);
    const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div>connected surface</div>
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();

    expect(getWorkspaceSocketTicket).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const subscribe = JSON.parse(socket.send.mock.calls[0]![0] as string) as {
      type: string; afterWaterline: number; diagnosticAttemptId: string;
    };
    expect(subscribe).toMatchObject({ type: 'subscribe', afterWaterline: 0 });
    expect(subscribe.diagnosticAttemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(reportTelemetryProductIntent.mock.calls
      .map(([intent]) => intent)
      .filter((intent: { kind: string }) => intent.kind === 'workspace_socket_handshake')).toEqual([
      { kind: 'workspace_socket_handshake', attemptId: subscribe.diagnosticAttemptId, phase: 'ticket_requested' },
      {
        kind: 'workspace_socket_handshake', attemptId: subscribe.diagnosticAttemptId, phase: 'ticket_received',
        sinceTicketRequested: 'lt_1s', windowVisible: true,
      },
      {
        kind: 'workspace_socket_handshake', attemptId: subscribe.diagnosticAttemptId, phase: 'transport_open',
        sinceTicketRequested: 'lt_1s', windowVisible: true,
      },
      { kind: 'workspace_socket_handshake', attemptId: subscribe.diagnosticAttemptId, phase: 'subscribe_sent' },
    ]);

    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000008',
      waterline: 8,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: WORKSPACE_SYNC_TOPICS,
      reason: 'initial',
    }));
    const invalidatedRoots = invalidations.mock.calls.map(([input]) => JSON.stringify(input?.queryKey));
    for (const root of [
      ['workspace'],
      ['workspace-onboarding'],
      ['workspace-members'],
      ['workspace-invitations'],
      ['connections'],
      ['connector-catalog'],
      ['connector-installation'],
      ['github-repository-access'],
      ['terminal-workspace-settings'],
      ['digest-schedule'],
      ['automation'],
      ['automation-draft'],
      ['automation-runs'],
      ['sidekicks-library'],
      ['attached-sidekicks'],
      ['workstream-sidekicks'],
      ['recommended-sidekicks'],
      ['note'],
      ['resources'],
      ['workstream-context'],
      ['work-opportunities'],
      ['activity'],
      ['workstreams'],
      ['telemetry-preference'],
      ['feature-flags'],
    ]) expect(invalidatedRoots).toContain(JSON.stringify(root));
    expect(queryClient.getQueryState(recommendationKey)?.isInvalidated).toBe(true);
    // The two sidebar lists are pushed whole, so a topic must never invalidate
    // them: nothing would refetch, and naming them here would suggest otherwise.
    for (const pushed of [['automations'], ['notes']]) {
      expect(invalidatedRoots).not.toContain(JSON.stringify(pushed));
    }
    // This event carried no sidebar, so the directory topic still means "go and
    // read it again". The case where it does carry one is below.
    expect(invalidatedRoots).toContain(JSON.stringify(['workstreams']));
    const invalidationCount = invalidations.mock.calls.length;
    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000007',
      waterline: 7,
      occurredAt: '2026-08-17T19:59:59.000Z',
      topics: ['workspace_profile'],
      reason: 'change',
    }));
    expect(invalidations).toHaveBeenCalledTimes(invalidationCount);
    act(() => socket.message({
      type: 'workspace_feature_flags',
      occurredAt: '2026-08-17T20:01:00.000Z',
      changedFlag: 'suggested-work-enabled',
      flags: {
        developerSettings: false,
        suggestedWorkEnabled: true,
        controlTowerRefreshSeconds: 60,
      },
    }));
    expect(queryClient.getQueryData(['feature-flags'])).toMatchObject({ suggestedWorkEnabled: true });
  });

  it('reports how deep an organization reconnect had to go, and stops reporting at teardown', async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div>connected surface</div>
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();

    act(() => FakeWebSocket.instances[0]!.open());
    // A close nobody here asked for reads as the server's, and the count is the
    // retry depth it dropped from rather than the one it is about to start.
    act(() => FakeWebSocket.instances[0]!.close(1012));
    // Past the first backoff (at most 1.5 s), and short of the open timeout.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await flushPromises();
    act(() => FakeWebSocket.instances[1]!.open());

    expect(socketTelemetry()).toEqual([
      { kind: 'realtime_socket_state', socket: 'workspace', state: 'connected', cause: 'opened', attempts: 'zero' },
      { kind: 'realtime_socket_state', socket: 'workspace', state: 'retrying', cause: 'server_closed', attempts: 'zero' },
      { kind: 'realtime_socket_state', socket: 'workspace', state: 'connected', cause: 'opened', attempts: 'one' },
    ]);

    // Teardown closes the socket too. Nothing failed and nothing is coming
    // back, so counting it would put an ordinary navigation in the drop rate.
    reportTelemetryProductIntent.mockClear();
    unmount();
    await flushPromises();
    expect(socketTelemetry()).toEqual([]);
  });

  it('times out a stranded reconnect ticket and starts another organization attempt', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const queryClient = new QueryClient();
    const ticket = {
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    };
    let requestCount = 0;
    const getWorkspaceSocketTicket = vi.fn(() => {
      requestCount += 1;
      if (requestCount === 2) {
        return requestSocketTicket(() => new Promise<typeof ticket>(() => undefined));
      }
      return Promise.resolve(ticket);
    });
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div>connected surface</div>
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    act(() => FakeWebSocket.instances[0]!.open());
    act(() => FakeWebSocket.instances[0]!.close(1012));

    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(getWorkspaceSocketTicket).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(SOCKET_TICKET_REQUEST_TIMEOUT_MS));
    expect(socketTelemetry()).toContainEqual({
      kind: 'realtime_socket_state',
      socket: 'workspace',
      state: 'retrying',
      cause: 'ticket_timeout',
      attempts: 'one',
    });
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(getWorkspaceSocketTicket).toHaveBeenCalledTimes(3);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('calls an offline transition during the ticket request what it is', async () => {
    const queryClient = new QueryClient();
    let ticketSignal: AbortSignal | undefined;
    const getWorkspaceSocketTicket = vi.fn((signal?: AbortSignal) => {
      ticketSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div>connected surface</div>
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    expect(ticketSignal?.aborted).toBe(false);

    // The desktop drops off the network while the ticket is still in flight.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await flushPromises();

    expect(ticketSignal?.aborted).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(socketTelemetry()).toEqual([{
      kind: 'realtime_socket_state',
      socket: 'workspace',
      state: 'stopped',
      cause: 'offline',
      attempts: 'zero',
    }]);
    expect(handshakeTelemetry().map(({ phase }) => phase)).toEqual([
      'ticket_requested', 'offline_blocked',
    ]);
  });

  describe('offline after ticket issuance', () => {
    let offline = false;
    beforeEach(() => {
      offline = false;
      vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => !offline);
    });

    it('reports an offline transition after the ticket resolves before dialing', async () => {
      const queryClient = new QueryClient();
      const getWorkspaceSocketTicket = vi.fn(async () => {
        offline = true;
        return {
          url: 'wss://api.rally.test/socket/workspaces/workspace-1',
          ticket: 'workspace-ticket',
          protocols: socketTicketProtocols('workspace-ticket'),
        };
      });
      render(
        <QueryClientProvider client={queryClient}>
          <WorkspaceSocketProvider region="global"
            api={{ getWorkspaceSocketTicket }}
            workspaceId="00000000-0000-7000-8000-000000000001"
          >
            <div />
          </WorkspaceSocketProvider>
        </QueryClientProvider>,
      );
      await flushPromises();

      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(handshakeTelemetry().map(({ phase }) => phase)).toEqual([
        'ticket_requested', 'ticket_received', 'offline_blocked',
      ]);
    });
  });

  it('reports a rejected sync once per attempt and still applies a later valid sync', async () => {
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => {
      socket.message({ type: 'workspace_sync', waterline: 'invalid' });
      socket.message({ type: 'workspace_sync', waterline: 'still-invalid' });
    });
    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000008',
      waterline: 8,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: ['workstream_directory'],
      reason: 'initial',
      sidebar: {
        workstreams: { directoryWaterline: 8, nextCursor: null, stateVersions: [], items: [] },
        automations: { waterline: 0, items: [] },
        notes: { waterline: 0, items: [] },
      },
    }));

    const events = handshakeTelemetry();
    expect(new Set(events.map(({ attemptId }) => attemptId)).size).toBe(1);
    expect(events.map(({ phase }) => phase)).toEqual([
      'ticket_requested', 'ticket_received', 'transport_open', 'subscribe_sent',
      'sync_rejected', 'sync_received', 'sync_applied',
    ]);
  });

  describe('a socket that the client cannot finish opening', () => {
    const ticket = {
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    };
    function renderProvider(getWorkspaceSocketTicket: (signal?: AbortSignal) => Promise<typeof ticket>) {
      return render(
        <QueryClientProvider client={new QueryClient()}>
          <WorkspaceSocketProvider region="global"
            api={{ getWorkspaceSocketTicket }}
            workspaceId="00000000-0000-7000-8000-000000000001"
          >
            <div />
          </WorkspaceSocketProvider>
        </QueryClientProvider>,
      );
    }

    it('replaces an expired handshake without waiting for its close event', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      renderProvider(vi.fn(async () => ticket));
      await flushPromises();
      const old = FakeWebSocket.instances[0]!;
      vi.spyOn(old, 'close').mockImplementation(() => undefined);
      await act(async () => vi.advanceTimersByTimeAsync(15_750));
      expect(FakeWebSocket.instances).toHaveLength(2);
      act(() => old.dispatchEvent(Object.assign(new Event('close'), {code: 1006})));
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('replaces a transport answering pongs without its initial sidebar', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      renderProvider(vi.fn(async () => ticket));
      await flushPromises();
      const old = FakeWebSocket.instances[0]!;
      act(() => old.open());
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      act(() => old.dispatchEvent(new MessageEvent('message', {data: 'pong'})));
      await act(async () => vi.advanceTimersByTimeAsync(5_750));
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(socketTelemetry()).toContainEqual(expect.objectContaining({cause: 'sync_timeout'}));
    });

    it('probes on foreground and keeps the first unanswered pong deadline', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      renderProvider(vi.fn(async () => ticket));
      await flushPromises();
      const old = FakeWebSocket.instances[0]!;
      act(() => { old.open(); old.message(initialSidebarFrame()); });
      vi.spyOn(old, 'close').mockImplementation(() => undefined);
      act(() => setApplicationForeground(true));
      expect(old.send).toHaveBeenCalledWith('ping');
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      act(() => setApplicationForeground(true));
      await act(async () => vi.advanceTimersByTimeAsync(5_750));
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(socketTelemetry()).toContainEqual(expect.objectContaining({cause: 'heartbeat_timeout'}));
    });

    it.each(['sleep', 'offline'] as const)('fences old tickets across %s, even if abort never settles', async (transition) => {
      let first!: (value: typeof ticket) => void;
      let second!: (value: typeof ticket) => void;
      const getTicket = vi.fn()
        .mockImplementationOnce(() => new Promise<typeof ticket>(resolve => { first = resolve; }))
        .mockImplementationOnce(() => new Promise<typeof ticket>(resolve => { second = resolve; }));
      renderProvider(getTicket);
      await flushPromises();
      if (transition === 'sleep') { setPowerState('suspended'); setPowerState('resumed'); }
      else act(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
      await flushPromises();
      expect(getTicket).toHaveBeenCalledTimes(2);
      await act(async () => first(ticket));
      act(() => window.dispatchEvent(new Event('online')));
      expect(getTicket).toHaveBeenCalledTimes(2);
      expect(FakeWebSocket.instances).toHaveLength(0);
      await act(async () => second(ticket));
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    // 2026-09-29: the server sent `101`, the Mac never saw it, and the socket
    // sat CONNECTING for twelve minutes while the server held it unheard.
    it('gives up on a socket that never opens, says why, and dials again', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const getWorkspaceSocketTicket = vi.fn(async () => ticket);
      renderProvider(getWorkspaceSocketTicket);
      await flushPromises();
      const stranded = FakeWebSocket.instances[0]!;

      await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_SOCKET_OPEN_TIMEOUT_MS); });

      expect(stranded.readyState).toBe(FakeWebSocket.CLOSED);
      expect(socketTelemetry()).toEqual([{
        kind: 'realtime_socket_state',
        socket: 'workspace',
        state: 'retrying',
        cause: 'open_timeout',
        attempts: 'zero',
      }]);
      expect(handshakeTelemetry()).toContainEqual(expect.objectContaining({
        phase: 'open_timeout',
        sinceTicketRequested: '5s_30s',
      }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('does not give up on a socket that opened and synchronized', async () => {
      vi.useFakeTimers();
      renderProvider(vi.fn(async () => ticket));
      await flushPromises();
      const socket = FakeWebSocket.instances[0]!;
      act(() => { socket.open(); socket.message(initialSidebarFrame()); });

      await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_SOCKET_OPEN_TIMEOUT_MS * 2); });

      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
      expect(handshakeTelemetry()).toContainEqual(expect.objectContaining({
        phase: 'transport_open',
        sinceTicketRequested: 'lt_1s',
      }));
    });

    it('closes its socket before sleep and dials only after wake', async () => {
      vi.useFakeTimers();
      const getWorkspaceSocketTicket = vi.fn(async () => ticket);
      renderProvider(getWorkspaceSocketTicket);
      await flushPromises();
      const beforeSleep = FakeWebSocket.instances[0]!;
      act(() => beforeSleep.open());
      reportTelemetryProductIntent.mockClear();

      setPowerState('suspended');
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

      expect(beforeSleep.readyState).toBe(FakeWebSocket.CLOSED);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(getWorkspaceSocketTicket).toHaveBeenCalledTimes(1);
      expect(socketTelemetry()).toEqual([expect.objectContaining({ state: 'retrying', cause: 'suspended' })]);

      setPowerState('resumed');
      await flushPromises();

      expect(getWorkspaceSocketTicket).toHaveBeenCalledTimes(2);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    // An aborted sleep can deliver `suspend` with no `resume`; the network
    // coming back or a person asking must still bring the socket back.
    it('dials again after a suspend with no resume, once online or asked', async () => {
      const getWorkspaceSocketTicket = vi.fn(async () => ticket);
      renderProvider(getWorkspaceSocketTicket);
      await flushPromises();
      act(() => FakeWebSocket.instances[0]!.open());

      setPowerState('suspended');
      await flushPromises();
      expect(FakeWebSocket.instances).toHaveLength(1);

      act(() => { window.dispatchEvent(new Event('online')); });
      await flushPromises();

      expect(getWorkspaceSocketTicket).toHaveBeenCalledTimes(2);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    // The close event of a socket closed for sleep can land after a resume
    // has dialled again: it must neither relabel the sleep nor go unreported.
    it('reports the sleep once when the old socket closes after the resume dials', async () => {
      const getWorkspaceSocketTicket = vi.fn(async () => ticket);
      renderProvider(getWorkspaceSocketTicket);
      await flushPromises();
      const beforeSleep = FakeWebSocket.instances[0]!;
      act(() => beforeSleep.open());
      // As a real socket does, `close()` only starts closing; the events come later.
      const closeLater = beforeSleep.close.bind(beforeSleep);
      beforeSleep.close = () => undefined;
      reportTelemetryProductIntent.mockClear();

      setPowerState('suspended');
      setPowerState('resumed');
      await flushPromises();
      expect(FakeWebSocket.instances).toHaveLength(2);
      act(() => {
        beforeSleep.dispatchEvent(new Event('error'));
        closeLater(1006);
      });

      expect(socketTelemetry()).toEqual([expect.objectContaining({ state: 'retrying', cause: 'suspended' })]);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('abandons a ticket still in flight when the machine sleeps', async () => {
      let ticketSignal: AbortSignal | undefined;
      const getWorkspaceSocketTicket = vi.fn((signal?: AbortSignal) => {
        ticketSignal = signal;
        return new Promise<typeof ticket>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      renderProvider(getWorkspaceSocketTicket);
      await flushPromises();

      setPowerState('suspended');
      await flushPromises();

      expect(ticketSignal?.aborted).toBe(true);
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(socketTelemetry()).toEqual([expect.objectContaining({ cause: 'suspended' })]);
    });
  });

  it('names the cause an organization close event cannot carry', async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div>connected surface</div>
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => { socket.open(); socket.message(initialSidebarFrame()); });
    reportTelemetryProductIntent.mockClear();

    // The heartbeat closes the socket itself when no pong answers, and the
    // close event that follows carries a code that says nothing about it. Past
    // both timers: the ping at 50s and the unanswered pong 15s after it.
    await act(async () => { await vi.advanceTimersByTimeAsync(66_000); });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

    expect(socketTelemetry()).toEqual([{
      kind: 'realtime_socket_state',
      socket: 'workspace',
      state: 'retrying',
      cause: 'heartbeat_timeout',
      attempts: 'zero',
    }]);
  });

  it('applies pushed access history and rejects a delayed older page', async () => {
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1', ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(<QueryClientProvider client={queryClient}><WorkspaceSocketProvider region="global"
      api={{ getWorkspaceSocketTicket }} workspaceId="00000000-0000-7000-8000-000000000001">
      <div /></WorkspaceSocketProvider></QueryClientProvider>);
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const page = {
      type: 'workspace_workstream_recency',
      directoryWaterline: 7,
      nextCursor: null,
      stateVersions: [{
        workstreamId: '00000000-0000-7000-8000-000000000002',
        commonEventId: '00000000-0000-7000-8000-000000000007',
        viewerEventId: '00000000-0000-7000-8001-000000000004',
        authorityGeneration: 1,
        commonWaterline: 7,
        viewerWaterline: 4,
      }],
      items: [{
        id: '00000000-0000-7000-8000-000000000002',
        workspaceId: '00000000-0000-7000-8000-000000000001',
        title: 'Socket-owned directory',
        titleStatus: 'settled',
        objective: 'Served by WorkspaceDO SQL',
        emailAddress: null,
        createdByUserId: '00000000-0000-7000-8000-000000000003',
        harnessStatus: 'running',
        latestAttentionSequenceNumber: 4,
        readThroughSequenceNumber: 2,
        manualUnreadFromSequenceNumber: null,
        manualUnreadGeneration: 0,
        hasUnread: true,
        youAreMentioned: true,
        firstUnreadSequenceNumber: 3,
        lastActivityAt: '2026-08-17T20:00:00.000Z',
        createdAt: '2026-08-17T19:00:00.000Z',
        updatedAt: '2026-08-17T20:00:00.000Z',
        archivedAt: null,
        scope: 'workspace',
        systemKind: null,
        nextPendingWakeup: null,
        pinPosition: null,
        participantUserIds: [],
        participantExtraCount: 0,
        spaceIds: [],
      }],
    };
    const access = '2026-09-07T20:00:00.000Z';
    const push = { type: page.type, directoryWaterline: 8, stateVersion: page.stateVersions[0],
      workstream: { ...page.items[0], lastAccessedAt: access } };
    act(() => socket.message(push));
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.lastAccessedAt).toBe(access);
    act(() => socket.message({ ...push, directoryWaterline: 9,
      workstream: { ...push.workstream, lastAccessedAt: '2026-09-08T20:00:00.000Z' } }));
    act(() => socket.message(push));
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.lastAccessedAt)
      .toBe('2026-09-08T20:00:00.000Z');
  });

  it('pages the authoritative channel directory over the organization socket', async () => {
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    let listWorkstreams: ReturnType<typeof useWorkspaceSocket>['listWorkstreams'] | null = null;
    function Probe(): null {
      const workspaceSocket = useWorkspaceSocket();
      useEffect(() => {
        listWorkstreams = workspaceSocket.listWorkstreams;
      }, [workspaceSocket.listWorkstreams]);
      return null;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <Probe />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    let result: Promise<unknown> | null = null;
    act(() => {
      result = listWorkstreams!({ limit: 250, includeSystem: false });
    });
    const command = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as {
      type: string;
      requestId: string;
    };
    expect(command).toMatchObject({ type: 'list_workstreams', limit: 250, includeSystem: false });
    act(() => socket.message({
      type: 'workspace_workstream_page',
      requestId: command.requestId,
      directoryWaterline: 7,
      nextCursor: null,
      stateVersions: [{
        workstreamId: '00000000-0000-7000-8000-000000000002',
        commonEventId: '00000000-0000-7000-8000-000000000007',
        viewerEventId: '00000000-0000-7000-8001-000000000004',
        authorityGeneration: 1,
        commonWaterline: 7,
        viewerWaterline: 4,
      }],
      items: [{
        id: '00000000-0000-7000-8000-000000000002',
        workspaceId: '00000000-0000-7000-8000-000000000001',
        title: 'Socket-owned directory',
        titleStatus: 'settled',
        objective: 'Served by WorkspaceDO SQL',
        emailAddress: null,
        createdByUserId: '00000000-0000-7000-8000-000000000003',
        harnessStatus: 'running',
        latestAttentionSequenceNumber: 4,
        readThroughSequenceNumber: 2,
        manualUnreadFromSequenceNumber: null,
        manualUnreadGeneration: 0,
        hasUnread: true,
        youAreMentioned: true,
        firstUnreadSequenceNumber: 3,
        lastActivityAt: '2026-08-17T20:00:00.000Z',
        createdAt: '2026-08-17T19:00:00.000Z',
        updatedAt: '2026-08-17T20:00:00.000Z',
        archivedAt: null,
        scope: 'workspace',
        systemKind: null,
        nextPendingWakeup: null,
        pinPosition: null,
        participantUserIds: [],
        participantExtraCount: 0,
        spaceIds: [],
      }],
    }));
    await expect(result).resolves.toMatchObject({
      nextCursor: null,
      items: [{ id: '00000000-0000-7000-8000-000000000002', title: 'Socket-owned directory' }],
    });
  });

  it('does not let a stale directory page resurrect a row after its tombstone', async () => {
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    let listWorkstreams: ReturnType<typeof useWorkspaceSocket>['listWorkstreams'] | null = null;
    function Probe(): null {
      const workspaceSocket = useWorkspaceSocket();
      useEffect(() => { listWorkstreams = workspaceSocket.listWorkstreams; }, [workspaceSocket.listWorkstreams]);
      return null;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global" api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001">
          <Probe />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const workstream = {
      ...summary(),
      workspaceId: '00000000-0000-7000-8000-000000000001',
      objective: 'Already archived',
      emailAddress: null,
      createdByUserId: null,
      createdAt: '2026-09-21T11:00:00.000Z',
      updatedAt: '2026-09-21T11:30:00.000Z',
      archivedAt: null,
      systemKind: null,
    };
    const stateVersion = {
      commonEventId: '00000000-0000-7000-8000-000000000007',
      viewerEventId: '00000000-0000-7000-8001-000000000004',
      authorityGeneration: 1,
      commonWaterline: 7,
      viewerWaterline: 4,
    };
    act(() => socket.message({
      type: 'workspace_workstream_state',
      occurredAt: '2026-09-21T11:30:00.000Z',
      workstreamId: workstream.id,
      stateVersion: { ...stateVersion, commonWaterline: 8 },
      workstream: null,
    }));
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY) ?? []).toEqual([]);

    let result: Promise<unknown> | null = null;
    act(() => { result = listWorkstreams!({ limit: 250, includeSystem: false }); });
    const command = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { requestId: string };
    act(() => socket.message({
      type: 'workspace_workstream_page',
      requestId: command.requestId,
      directoryWaterline: 7,
      nextCursor: null,
      stateVersions: [{ workstreamId: workstream.id, ...stateVersion }],
      items: [workstream],
    }));

    await expect(result).resolves.toEqual({ items: [], nextCursor: null });
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY) ?? []).toEqual([]);
  });

  it('paints the whole sidebar from the subscribe answer, without asking for it', async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    const owner = render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000017',
      waterline: 4,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: ['workstream_directory'],
      reason: 'initial',
      featureFlags: {
        developerSettings: false,
        suggestedWorkEnabled: false,
        controlTowerRefreshSeconds: 60,
      },
      sidebar: {
      workstreams: {
        directoryWaterline: 7,
        nextCursor: null,
        stateVersions: [{
          workstreamId: '00000000-0000-7000-8000-000000000002',
          commonEventId: '00000000-0000-7000-8000-000000000007',
          viewerEventId: '00000000-0000-7000-8001-000000000004',
          authorityGeneration: 1,
          commonWaterline: 7,
          viewerWaterline: 4,
        }],
        items: [{
          id: '00000000-0000-7000-8000-000000000002',
          workspaceId: '00000000-0000-7000-8000-000000000001',
          title: 'Socket-owned directory',
          titleStatus: 'settled',
          objective: 'Served by WorkspaceDO SQL',
          emailAddress: null,
          createdByUserId: '00000000-0000-7000-8000-000000000003',
          harnessStatus: 'running',
          latestAttentionSequenceNumber: 4,
          readThroughSequenceNumber: 2,
          manualUnreadFromSequenceNumber: null,
          manualUnreadGeneration: 0,
          hasUnread: true,
          youAreMentioned: true,
          firstUnreadSequenceNumber: 3,
          lastActivityAt: '2026-08-17T20:00:00.000Z',
          createdAt: '2026-08-17T19:00:00.000Z',
          updatedAt: '2026-08-17T20:00:00.000Z',
          archivedAt: null,
          scope: 'workspace',
          systemKind: null,
          nextPendingWakeup: null,
          pinPosition: null,
          participantUserIds: [],
          participantExtraCount: 0,
          spaceIds: [],
        }],
      },
      automations: { waterline: 3, items: [{
        id: '00000000-0000-7000-8000-000000000005',
        name: 'Monday brief',
        description: 'Every Monday',
        emailAddress: null,
        scope: 'workspace',
        status: 'active',
        nextRunAt: null,
        lastRunAt: null,
        updatedAt: '2026-08-17T19:00:00.000Z',
      }] },
      notes: { waterline: 1, items: [{
        id: '00000000-0000-7000-8000-000000000006',
        workspaceId: '00000000-0000-7000-8000-000000000001',
        resourceId: '00000000-0000-7000-8000-000000000009',
        ownerUserId: '00000000-0000-7000-8000-000000000003',
        scope: 'workspace',
        title: 'Standup',
        recordingStatus: 'idle',
        recordedMs: 0,
        startedAt: null,
        endedAt: null,
        generatedAt: null,
        lastActivityAt: '2026-08-17T21:00:00.000Z',
        createdAt: '2026-08-17T19:00:00.000Z',
        updatedAt: '2026-08-17T21:00:00.000Z',
        archivedAt: null,
      }] },
      },
    }));

    act(() => socket.message({
      type: 'workspace_space_snapshot',
      occurredAt: '2026-08-27T00:01:00.000Z',
      spacesReady: true,
      ordering: [],
      spaces: {
        active: { waterline: 4, items: [] },
        inactive: { waterline: 4, items: [] },
      },
    }));

    // All three painted from a frame nobody asked for.
    expect(queryClient.getQueryData(['workstreams']))
      .toEqual([expect.objectContaining({ id: '00000000-0000-7000-8000-000000000002' })]);
    expect(queryClient.getQueryData(['automations']))
      .toEqual([expect.objectContaining({ id: '00000000-0000-7000-8000-000000000005', scope: 'workspace' })]);
    expect(queryClient.getQueryData(['notes']))
      .toBeUndefined();
    expect(queryClient.getQueryData(['feature-flags']))
      .toMatchObject({ suggestedWorkEnabled: false });
    const handshakePhases = reportTelemetryProductIntent.mock.calls
      .map(([intent]) => intent as { kind: string; phase?: string })
      .filter((intent) => intent.kind === 'workspace_socket_handshake')
      .map((intent) => intent.phase);
    expect(handshakePhases).toEqual([
      'ticket_requested', 'ticket_received', 'transport_open',
      'subscribe_sent', 'sync_received', 'sync_applied',
    ]);

    // The point of the payload: the only thing the client said was where it
    // had got to. A directory request here would be the round trip this frame
    // exists to remove.
    const sent = socket.send.mock.calls.map(([frame]) => JSON.parse(String(frame)) as { type: string });
    expect(sent.map((frame) => frame.type)).toEqual(['subscribe', 'set_presence']);
    // No screen observes these entries. The workspace subscription owns the
    // directory and its ordering ledgers even when their screens are absent.
    const keys = ['workstreams', 'automations', 'spaces', 'spaces-inactive', 'personal-order',
      'feature-flags', 'workstream-state-waterlines', 'workspace-directory-waterlines']
      .map((key) => [key]);
    const snapshot = keys.map((key) => queryClient.getQueryData(key));
    expect(snapshot.every((value) => value !== undefined)).toBe(true);
    socket.send.mockImplementation((frame: string) => {
      if (frame === 'ping') queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: 'pong' })));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(keys.map((key) => queryClient.getQueryData(key))).toEqual(snapshot);
    expect(getWorkspaceSocketTicket).toHaveBeenCalledTimes(1);
    owner.unmount();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(keys.map((key) => queryClient.getQueryData(key))).toEqual(keys.map(() => undefined));
    queryClient.clear();
  });

  it('does not ask for the directory it was just handed', async () => {
    const queryClient = new QueryClient();
    const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    const confirmSocketTicket = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket, confirmSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(confirmSocketTicket).not.toHaveBeenCalled();
    invalidations.mockClear();

    // `initial` names every topic, the directory among them — and carries the
    // directory. Invalidating it here would send the client straight back for
    // the page this event just delivered, which is the round trip the payload
    // exists to remove.
    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-00000000001a',
      waterline: 11,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: ['workstream_directory', 'workspace_profile'],
      reason: 'initial',
      sidebar: {
        workstreams: { directoryWaterline: 1, nextCursor: null, stateVersions: [], items: [] },
        automations: { waterline: 0, items: [] },
        notes: { waterline: 0, items: [] },
      },
    }));

    const roots = invalidations.mock.calls.map(([input]) => JSON.stringify(input?.queryKey));
    expect(roots).not.toContain(JSON.stringify(['workstreams']));
    // Every other topic on the same event is untouched by this.
    expect(roots).toContain(JSON.stringify(['workspace']));
    expect(confirmSocketTicket).toHaveBeenCalledExactlyOnceWith(await getWorkspaceSocketTicket.mock.results[0]!.value);
  });

  it('asks for the directory when the payload leaves a resident row unaccounted for', async () => {
    const queryClient = new QueryClient();
    // A row already resident from before the socket dropped. The reconnect
    // payload is page one and does not carry it, which page one alone cannot
    // explain: it is either a later page the reader had scrolled to, or a work
    // stream archived while the socket was away. Merging keeps it either way,
    // so the refetch has to run and let the full walk decide.
    setCachedWorkstreams(queryClient, () => [summary({
      id: '00000000-0000-7000-8000-0000000000ff',
      title: 'Archived while the socket was away',
    })]);
    const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    invalidations.mockClear();

    // A `nextCursor` means this really is page one, so the resident row could
    // still be a later page the reader had scrolled to.
    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-00000000001b',
      waterline: 12,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: ['workstream_directory'],
      reason: 'initial',
      sidebar: {
        workstreams: {
          directoryWaterline: 1,
          nextCursor: '1755460800000:00000000-0000-7000-8000-0000000000aa',
          stateVersions: [],
          items: [],
        },
        automations: { waterline: 0, items: [] },
        notes: { waterline: 0, items: [] },
      },
    }));

    const roots = invalidations.mock.calls.map(([input]) => JSON.stringify(input?.queryKey));
    expect(roots).toContain(JSON.stringify(WORKSTREAMS_QUERY_KEY));
  });

  it('drops a resident row the whole directory no longer lists, without a refetch', async () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, () => [summary({
      id: '00000000-0000-7000-8000-0000000000ff',
      title: 'Archived while the socket was away',
    })]);
    const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    invalidations.mockClear();

    // No `nextCursor`: the payload is not page one, it is the whole directory.
    // A resident row missing from it has no second reading, so it goes here and
    // the refetch that would have decided is not worth asking for.
    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-00000000001c',
      waterline: 13,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: ['workstream_directory'],
      reason: 'initial',
      sidebar: {
        workstreams: { directoryWaterline: 1, nextCursor: null, stateVersions: [], items: [] },
        automations: { waterline: 0, items: [] },
        notes: { waterline: 0, items: [] },
      },
    }));

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)).toEqual([]);
    const roots = invalidations.mock.calls.map(([input]) => JSON.stringify(input?.queryKey));
    expect(roots).not.toContain(JSON.stringify(WORKSTREAMS_QUERY_KEY));
  });

  it('takes the sidebar off a resume whose waterline is not newer', async () => {
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const sidebar = (waterline: number, name: string) => ({
      workstreams: { directoryWaterline: 1, nextCursor: null, stateVersions: [], items: [] },
      automations: { waterline, items: [{
        id: '00000000-0000-7000-8000-000000000005',
        name,
        description: 'Every Monday',
        emailAddress: null,
        scope: 'workspace' as const,
        status: 'active' as const,
        nextRunAt: null,
        lastRunAt: null,
        updatedAt: '2026-08-17T19:00:00.000Z',
      }] },
      notes: { waterline: 0, items: [] },
    });

    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000018',
      waterline: 9,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: ['workstream_directory'],
      reason: 'initial',
      sidebar: sidebar(1, 'First'),
    }));
    expect(queryClient.getQueryData(['automations']))
      .toEqual([expect.objectContaining({ name: 'First' })]);

    // A reconnect where no topic moved: the server repeats the waterline the
    // client already holds. The topic half is rightly ignored, but the sidebar
    // rides on the same event and is the whole reason it was sent — a guard
    // that ran before it would leave this socket on state it missed.
    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000019',
      waterline: 9,
      occurredAt: '2026-08-17T20:01:00.000Z',
      topics: [],
      reason: 'resume',
      sidebar: sidebar(2, 'Caught up while away'),
    }));
    expect(queryClient.getQueryData(['automations']))
      .toEqual([expect.objectContaining({ name: 'Caught up while away' })]);
  });

  it('scopes live Space authority between this connection’s open and snapshot', async () => {
    const queryClient = new QueryClient();
    function Probe(): JSX.Element {
      const { sidebarConnect } = useWorkspaceSocket();
      return <div data-testid="spaces-live">{String(sidebarConnect?.spacesLive ?? false)}</div>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket: vi.fn(async () => ({
            url: 'wss://api.rally.test/socket/workspaces/workspace-1',
            ticket: 'workspace-ticket',
            protocols: socketTicketProtocols('workspace-ticket'),
          })) }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <Probe />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000018',
      waterline: 1,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: ['workstream_directory'],
      reason: 'initial',
      sidebar: {
        workstreams: { directoryWaterline: 1, nextCursor: null, stateVersions: [], items: [] },
        automations: { waterline: 0, items: [] },
        notes: { waterline: 0, items: [] },
      },
    }));
    expect(screen.getByTestId('spaces-live')).toHaveTextContent('false');

    act(() => socket.message({
      type: 'workspace_space_snapshot',
      occurredAt: '2026-08-17T20:01:00.000Z',
      spacesReady: true,
      ordering: [],
      spaces: {
        active: { waterline: 1, items: [] },
        inactive: { waterline: 1, items: [] },
      },
    }));
    expect(screen.getByTestId('spaces-live')).toHaveTextContent('true');

    // The next transport is connected before its subscribe response arrives.
    // Its open event must revoke the previous transport's snapshot meanwhile.
    act(() => socket.open());
    expect(screen.getByTestId('spaces-live')).toHaveTextContent('false');
  });

  it('subscribes composer targets and consumes versioned socket counts through reconnect and unmount', async () => {
    const queryClient = new QueryClient();
    const target = { parentKind: 'workstream' as const, parentId: '00000000-0000-7000-8000-000000000002', substreamId: '0' };
    const other = { parentKind: 'space' as const, parentId: '00000000-0000-7000-8000-000000000003', substreamId: '0' };
    function Count(): JSX.Element { return <div data-testid="sidekick-count">{useSidekickActivity(target) ?? 'unknown'}</div>; }
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket', protocols: socketTicketProtocols('workspace-ticket'),
    }));
    const view = (show: boolean) => <QueryClientProvider client={queryClient}>
      <WorkspaceSocketProvider region="global" api={{ getWorkspaceSocketTicket }}
        workspaceId="00000000-0000-7000-8000-000000000001">{show && <Count />}</WorkspaceSocketProvider>
    </QueryClientProvider>;
    const rendered = render(view(true));
    await flushPromises();
    let socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const sync = { type: 'workspace_sync', eventId: '00000000-0000-7000-8000-000000000008',
      waterline: 8, occurredAt: '2026-08-17T20:01:00.000Z', topics: ['sidekick_activity'], reason: 'initial' };
    act(() => socket.message(sync));
    const commands = () => socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as { type: string; revision: number; targets: unknown[] })
      .filter((command) => command.type === 'sidekick_activity');
    expect(commands().at(-1)).toMatchObject({ type: 'sidekick_activity', revision: 1, targets: [target] });
    const event = { type: 'workspace_sidekick_activity', revision: 1, target, waterline: 8, count: 2 };
    act(() => socket.message(event));
    await flushPromises();
    await waitFor(() => expect(screen.getByTestId('sidekick-count')).toHaveTextContent('2'));
    act(() => socket.message({ ...event, waterline: 7, count: 0 }));
    act(() => socket.message({ ...event, target: other, waterline: 9, count: 10 }));
    await flushPromises();
    await waitFor(() => expect(screen.getByTestId('sidekick-count')).toHaveTextContent('2'));
    act(() => socket.message({ ...event, waterline: 10, count: 0 }));
    await flushPromises();
    await waitFor(() => expect(screen.getByTestId('sidekick-count')).toHaveTextContent('0'));
    // A transport's new subscribe answer re-registers the retained composer target.
    act(() => { socket.close(1012); window.dispatchEvent(new Event('online')); });
    await flushPromises();
    socket = FakeWebSocket.instances[1]!;
    act(() => socket.open());
    act(() => socket.message({ ...sync, waterline: 11 }));
    expect(commands().at(-1)).toMatchObject({ revision: 2, targets: [target] });
    act(() => socket.message({ ...event, revision: 1, waterline: 12, count: 5 }));
    await flushPromises();
    await waitFor(() => expect(screen.getByTestId('sidekick-count')).toHaveTextContent('0'));
    act(() => socket.message({ ...event, revision: 2, waterline: 12, count: 1 }));
    await flushPromises();
    await waitFor(() => expect(screen.getByTestId('sidekick-count')).toHaveTextContent('1'));
    rendered.rerender(view(false));
    expect(commands().at(-1)).toMatchObject({ revision: 3, targets: [] });
  });

  it('refetches an open automation page when its list row is pushed', async () => {
    const queryClient = new QueryClient();
    const automationId = '00000000-0000-7000-8000-000000000005';
    queryClient.setQueryData(['automation', automationId], { id: automationId, currentDefinition: null });
    queryClient.setQueryData(['automation-runs', automationId], []);
    queryClient.setQueryData(['sidekicks-library'], []);
    queryClient.setQueryData(['sidekick-activity', 'workstream', 'room', '0'], 0);
    queryClient.setQueryData(['attached-sidekicks', 'room'], []);
    queryClient.setQueryData(['workstream-sidekicks', 'room'], []);
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(queryClient.getQueryState(['automation', automationId])?.isInvalidated).toBe(false);

    // The automation's own chat submitted a revision: the object pushed the
    // sidebar list and nothing else, since no HTTP request of the desktop's
    // was in play. The page's detail query has to hear it, or Create stays
    // disabled on a stale definition until something else refetches.
    act(() => socket.message({
      type: 'workspace_sidebar_list',
      occurredAt: '2026-08-17T20:00:00.000Z',
      list: 'automations',
      waterline: 3,
      items: [{
        id: automationId,
        name: 'Weekly changelog',
        description: 'Every Monday',
        emailAddress: null,
        scope: 'workspace',
        status: 'draft',
        nextRunAt: null,
        lastRunAt: null,
        updatedAt: '2026-08-17T19:00:00.000Z',
      }],
    }));

    expect(queryClient.getQueryState(['automation', automationId])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['automation-runs', automationId])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['sidekicks-library'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['sidekick-activity', 'workstream', 'room', '0'])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(['attached-sidekicks', 'room'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['workstream-sidekicks', 'room'])?.isInvalidated).toBe(true);
  });

  it('drops a sidebar list whose version is not newer than the one applied', async () => {
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const push = (waterline: number, name: string) => socket.message({
      type: 'workspace_sidebar_list',
      occurredAt: '2026-08-17T20:00:00.000Z',
      list: 'automations',
      waterline,
      items: [{
        id: '00000000-0000-7000-8000-000000000005',
        name,
        description: 'Every Monday',
        emailAddress: null,
        scope: 'workspace',
        status: 'active',
        nextRunAt: null,
        lastRunAt: null,
        updatedAt: '2026-08-17T19:00:00.000Z',
      }],
    });

    act(() => push(7, 'Newest'));
    expect(queryClient.getQueryData(['automations']))
      .toEqual([expect.objectContaining({ name: 'Newest' })]);

    // A redelivery of the same version, and a straggler from before it. Neither
    // is newer, so neither may overwrite what is on screen — this is the whole
    // reason the list carries a version rather than trusting arrival order.
    act(() => push(7, 'Duplicate'));
    expect(queryClient.getQueryData(['automations']))
      .toEqual([expect.objectContaining({ name: 'Newest' })]);
    act(() => push(6, 'Stale'));
    expect(queryClient.getQueryData(['automations']))
      .toEqual([expect.objectContaining({ name: 'Newest' })]);

    act(() => push(8, 'Newer still'));
    expect(queryClient.getQueryData(['automations']))
      .toEqual([expect.objectContaining({ name: 'Newer still' })]);
  });

  it('applies active and archived space state from the socket and drops an older snapshot', async () => {
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const space = {
      id: '00000000-0000-7000-8000-0000000000f2',
      name: 'Hiring',
      iconKey: 'briefcase',
      colorKey: 'blue',
      scope: 'personal',
      status: 'active',
      systemRole: null,
      revision: 1,
      reach: 'participant',
      participants: [],
      channelCount: 0,
      defaultResourceIds: [],
      defaultSidekickIds: [],
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    };
    act(() => socket.message({
      type: 'workspace_space_snapshot',
      occurredAt: '2026-08-27T00:01:00.000Z',
      spacesReady: true,
      // Required on this event and optional on the connect payload: a server
      // that sends this message is a server that has the ordering.
      ordering: [{ container: { kind: 'space', id: space.id }, itemIds: [] }],
      spaces: {
        active: { waterline: 4, items: [space] },
        inactive: { waterline: 4, items: [] },
      },
    }));
    expect(queryClient.getQueryData(['spaces'])).toEqual({ waterline: 4, items: [space] });
    expect(queryClient.getQueryData(['spaces-inactive'])).toEqual({ waterline: 4, items: [] });
    expect(queryClient.getQueryData(['personal-order']))
      .toEqual([{ container: { kind: 'space', id: space.id }, itemIds: [] }]);

    act(() => socket.message({
      type: 'workspace_space_snapshot',
      occurredAt: '2026-08-27T00:02:00.000Z',
      spacesReady: false,
      ordering: [],
      spaces: {
        active: { waterline: 3, items: [] },
        inactive: { waterline: 3, items: [{ ...space, status: 'archived' }] },
      },
    }));
    expect(queryClient.getQueryData(['spaces'])).toEqual({ waterline: 4, items: [space] });
    expect(queryClient.getQueryData(['spaces-inactive'])).toEqual({ waterline: 4, items: [] });
    // The dropped snapshot's `spacesReady` is dropped with it: an older payload
    // must not put the organization-opening state back over a finished cutover.
    expect(queryClient.getQueryData(['spaces-ready'])).toBe(true);
    // And its ordering, for the same reason: the arrangement on screen must
    // not be replaced by one a stale payload carried.
    expect(queryClient.getQueryData(['personal-order']))
      .toEqual([{ container: { kind: 'space', id: space.id }, itemIds: [] }]);
  });

  // A required field added to a pushed event fails every receiver that predates
  // it, and the handler's schema chain drops what it cannot read either way. A
  // desktop running ahead of its API would therefore show no Spaces at all,
  // with nothing anywhere naming the field that was missing.
  it('names the field when a pushed event this build knows the type of does not parse', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    warn.mockClear();

    // The skew this is about: an API that predates `reach`, whose Space rows
    // arrive without it.
    act(() => socket.message({
      type: 'workspace_space_snapshot',
      occurredAt: '2026-08-27T00:01:00.000Z',
      spacesReady: true,
      ordering: [],
      spaces: {
        active: {
          waterline: 4,
          items: [{
            id: '00000000-0000-7000-8000-0000000000f2',
            name: 'Hiring',
            iconKey: 'briefcase',
            colorKey: 'blue',
            scope: 'personal',
            status: 'active',
            systemRole: null,
            revision: 1,
            participants: [],
            channelCount: 0,
            defaultResourceIds: [],
            defaultSidekickIds: [],
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
          }],
        },
        inactive: { waterline: 4, items: [] },
      },
    }));

    expect(queryClient.getQueryData(['spaces'])).toBeUndefined();
    const line = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(line).toContain('space snapshot');
    expect(line).toContain('reach');

    // A message whose type no schema here knows is the ordinary
    // forward-compatible case and says nothing at all.
    warn.mockClear();
    act(() => socket.message({ type: 'something_a_newer_server_sends', occurredAt: '2026-08-27T00:02:00.000Z' }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // The Space dashboard's page is fetched, not pushed, so WorkspaceDO sends a
  // nudge naming the Spaces to read again rather than the rows. This is the
  // only thing that invalidates that entry while the screen is open.
  it('invalidates only the named Channels\' feeds, the Threads list, the Channel counts and Activity when a nudge arrives', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, {
      waterline: 1,
      items: [{
        id: asSpaceId('00000000-0000-7000-8000-0000000000f2'),
        name: 'Hiring',
        iconKey: 'briefcase',
        colorKey: 'blue',
        scope: 'workspace',
        status: 'active',
        systemRole: null,
        revision: 1,
        reach: 'organization',
        participants: [],
        channelCount: 2,
        attentionCount: 0,
        defaultResourceIds: [],
        defaultSidekickIds: [],
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      }],
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    invalidate.mockClear();

    act(() => socket.message({
      type: 'space_conversations_changed',
      occurredAt: '2026-08-27T00:01:00.000Z',
      spaceIds: [
        '00000000-0000-7000-8000-0000000000f2',
        '00000000-0000-7000-8000-0000000000f3',
      ],
      attentionCounts: [
        { spaceId: '00000000-0000-7000-8000-0000000000f2', count: 3 },
        { spaceId: '00000000-0000-7000-8000-0000000000f3', count: 1 },
      ],
    }));

    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    // The named Channels' feeds, the Threads tab's list, which a placement
    // can add to, the Channels tab's thread counts, and Activity, which lists
    // the thread starts a placement brings. A Channel the nudge
    // did not name is a feed this change cannot have moved, and refetching it
    // would be one wasted page read per message in the Organization.
    expect(keys).toEqual([
      ['channel-feed', '00000000-0000-7000-8000-0000000000f2'],
      ['channel-feed', '00000000-0000-7000-8000-0000000000f3'],
      ['merge-channels'],
      ['my-threads'],
      ['channel-stats'],
      ['activity'],
    ]);
    expect(queryClient.getQueryData<SpaceDirectory>(SPACES_QUERY_KEY)?.items[0]?.attentionCount).toBe(3);
  });

  it('reads guest navigation and eligible merge Channels again when reach changes', async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    invalidate.mockClear();

    act(() => socket.message({
      type: 'workspace_reach_changed',
      occurredAt: '2026-09-24T00:00:00.000Z',
      userIds: ['00000000-0000-7000-8000-000000000003'],
    }));
    await flushPromises();

    // A member's Channel rows and Space pages are pushed on the same flip, so
    // the associative read a guest's sidebar is drawn from is the one to redo.
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ['merge-channels'], ['shared-navigation'], ['conversation-access-preview'],
    ]);
  });

  it.each([
    ['thread', '0', 'reach', true],
    ['breakout', '00000000-0000-7000-8000-0000000000b1', 'reach', true],
    ['thread', '0', 'reconnect', true],
    ['breakout', '00000000-0000-7000-8000-0000000000b1', 'reconnect', true],
    ['thread', '0', 'reach', false],
  ] as const)('retries a waiting %s (%s) after %s (request sent: %s)', async (kind, substreamId, change, requested) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let admitted = false;
    const onRetry = vi.fn();
    const api = {
      getWorkspaceSocketTicket: async () => ({
        url: 'wss://api.rally.test/socket/workspaces/workspace-1', ticket: 'workspace-ticket',
        protocols: socketTicketProtocols('workspace-ticket'),
      }),
      conversationAccessPreview: vi.fn(async () => ({
        kind: substreamId === '0' ? 'channel' as const : 'breakout' as const,
        title: 'Launch plan', appearance: null, markId: 'thread-1',
        access: admitted ? 'open' as const : 'requestable' as const,
      })),
      requestConversationAccess: async () => undefined,
    };
    render(<QueryClientProvider client={queryClient}>
      <WorkspaceSocketProvider region="global" api={api} workspaceId="00000000-0000-7000-8000-000000000001">
        <ConversationAccessRequest api={api} parentId="thread-1" substreamId={substreamId}
          fallback={<p>Opening thread</p>} onRetry={onRetry} />
      </WorkspaceSocketProvider>
    </QueryClientProvider>);
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => { socket.open(); socket.message(initialSidebarFrame()); });
    const requestButton = await screen.findByRole('button', { name: 'Request access' });
    if (requested) {
      fireEvent.click(requestButton);
      await screen.findByRole('button', { name: 'Try again' });
    }
    await flushPromises();
    api.conversationAccessPreview.mockClear();
    const reach = {
      type: 'workspace_reach_changed', occurredAt: '2026-10-22T00:00:00.000Z',
      userIds: ['00000000-0000-7000-8000-000000000003'],
    };
    // A refreshed preview that still refuses access must not retry the socket.
    act(() => socket.message(reach));
    await vi.waitFor(() => expect(api.conversationAccessPreview).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(onRetry).not.toHaveBeenCalled();
    admitted = true;
    if (change === 'reach') {
      act(() => socket.message(reach));
    } else {
      act(() => {
        socket.close();
        window.dispatchEvent(new Event('online'));
      });
      await flushPromises();
      const reconnected = FakeWebSocket.instances.at(-1)!;
      expect(reconnected).not.toBe(socket);
      // The waterline did not advance while disconnected: recovery must run
      // before the duplicate-waterline guard drops this subscribe answer.
      act(() => { reconnected.open(); reconnected.message(initialSidebarFrame()); });
    }
    await vi.waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(api.conversationAccessPreview).toHaveBeenLastCalledWith('thread-1', substreamId);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(`Opening ${kind}…`);
    expect(screen.queryByText('Opening thread')).toBeNull();
  });


  it.each(['placement', 'reach', 'reconnect'] as const)('refreshes the open Thread merge targets after a %s change', async (change) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let eligible = false;
    const api = {
      getWorkspaceSocketTicket: async () => ({
        url: 'wss://api.rally.test/socket/workspaces/workspace-1', ticket: 'workspace-ticket',
        protocols: socketTicketProtocols('workspace-ticket'),
      }),
      mergeChannels: async () => ({ channels: eligible ? [{ id: '00000000-0000-7000-8000-0000000000f2', name: 'GTM' }] : [] }),
    };
    function Probe(): JSX.Element {
      const ids = useMergeChannels(api, 'thread-1', true);
      return <output data-testid="merge-targets">{ids === undefined ? 'loading' : ids.join(',') || 'none'}</output>;
    }
    render(<QueryClientProvider client={queryClient}>
      <WorkspaceSocketProvider region="global" api={api} workspaceId="00000000-0000-7000-8000-000000000001">
        <Probe />
      </WorkspaceSocketProvider>
    </QueryClientProvider>);
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    await vi.waitFor(() => expect(screen.getByTestId('merge-targets').textContent).toBe('none'), { timeout: 5000 });
    eligible = true;
    const event = change === 'placement' ? {
      type: 'space_conversations_changed', occurredAt: '2026-10-19T00:00:00.000Z',
      spaceIds: ['00000000-0000-7000-8000-0000000000f2'], attentionCounts: [], placementChanged: true,
    } : change === 'reach' ? {
      type: 'workspace_reach_changed', occurredAt: '2026-10-19T00:00:00.000Z',
      userIds: ['00000000-0000-7000-8000-000000000003'],
    } : {
      type: 'workspace_sync', eventId: '00000000-0000-7000-8000-000000000018', waterline: 9,
      occurredAt: '2026-10-19T00:00:00.000Z', topics: [], reason: 'resume',
      sidebar: {
        workstreams: { directoryWaterline: 1, nextCursor: null, stateVersions: [], items: [] },
        automations: { waterline: 0, items: [] }, notes: { waterline: 0, items: [] },
      },
    };
    act(() => socket.message(event));
    await vi.waitFor(() => expect(screen.getByTestId('merge-targets').textContent).toBe('00000000-0000-7000-8000-0000000000f2'), { timeout: 5000 });
    eligible = false;
    act(() => socket.message(event));
    await vi.waitFor(() => expect(screen.getByTestId('merge-targets').textContent).toBe('none'), { timeout: 5000 });
  });

  it('fails an in-flight directory page immediately when the desktop goes offline', async () => {
    let online = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    let listWorkstreams: ReturnType<typeof useWorkspaceSocket>['listWorkstreams'] | null = null;
    function Probe(): null {
      const workspaceSocket = useWorkspaceSocket();
      useEffect(() => {
        listWorkstreams = workspaceSocket.listWorkstreams;
      }, [workspaceSocket.listWorkstreams]);
      return null;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider region="global"
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <Probe />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    act(() => FakeWebSocket.instances[0]!.open());
    const result = listWorkstreams!({ limit: 20, includeSystem: false });
    const rejection = expect(result).rejects.toMatchObject({ code: 'workspace_directory_offline' });

    online = false;
    act(() => window.dispatchEvent(new Event('offline')));

    await rejection;
  });
});

describe('a Channel\'s breakouts and background agents on the organization socket', () => {
  /**
   * These used to arrive on one Channel control socket per held Channel. They
   * now ride the Organization socket's Channel rows, so these tests drive the
   * real provider with the frames the server sends and read the caches the
   * Channel screen and the composer observe.
   */
  const workstreamId = '00000000-0000-7000-8000-000000000002';
  const workspaceId = '00000000-0000-7000-8000-000000000001';
  const creator = '00000000-0000-7000-8000-000000000013';
  const kept = '00000000-0000-7000-8000-000000000021';
  const dropped = '00000000-0000-7000-8000-000000000022';

  function child(substreamId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      substreamId, title: 'Breakout', createdByUserId: creator,
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z', ...extra,
    };
  }

  function row(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: workstreamId, workspaceId, title: 'Channel', titleStatus: 'settled', objective: '',
      emailAddress: null, createdByUserId: null, harnessStatus: 'completed',
      latestAttentionSequenceNumber: 4, readThroughSequenceNumber: 2, manualUnreadFromSequenceNumber: null,
      manualUnreadGeneration: 0, hasUnread: false, youAreMentioned: false, firstUnreadSequenceNumber: null,
      lastActivityAt: '2026-08-17T20:00:00.000Z', createdAt: '2026-08-17T19:00:00.000Z',
      updatedAt: '2026-08-17T20:00:00.000Z', archivedAt: null, scope: 'workspace', systemKind: null,
      nextPendingWakeup: null, pinPosition: null, participantUserIds: [], participantExtraCount: 0, spaceIds: [],
      ...extra,
    };
  }

  function version(commonWaterline: number): Record<string, unknown> {
    return {
      commonEventId: `00000000-0000-7000-8000-${commonWaterline.toString(16).padStart(12, '0')}`,
      viewerEventId: '00000000-0000-7000-8001-000000000004',
      authorityGeneration: 1,
      commonWaterline,
      viewerWaterline: 4,
    };
  }

  function stateFrame(commonWaterline: number, extra: Record<string, unknown> | null): Record<string, unknown> {
    return {
      type: 'workspace_workstream_state',
      occurredAt: '2026-08-17T20:00:00.000Z',
      workstreamId,
      stateVersion: version(commonWaterline),
      workstream: extra === null ? null : row(extra),
    };
  }

  function sidebarFrame(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000017',
      waterline: 4,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: ['workstream_directory'],
      reason: 'initial',
      sidebar: {
        workstreams: {
          directoryWaterline: 7, nextCursor: null,
          stateVersions: [{ workstreamId, ...version(7) }],
          items: [row(extra)],
        },
        automations: { waterline: 1, items: [] },
        notes: { waterline: 1, items: [], nextCursor: null },
      },
    };
  }

  async function connect(
    queryClient: QueryClient,
    scope: string | null = null,
    content: ReactNode = <div />,
  ): Promise<FakeWebSocket> {
    const api = {
      getWorkspaceSocketTicket: vi.fn(async () => ({
        url: 'wss://api.rally.test/socket/workspaces/workspace-1',
        ticket: 'workspace-ticket',
        protocols: socketTicketProtocols('workspace-ticket'),
      })),
    };
    const provider = (
      <WorkspaceSocketProvider region="global" api={api} workspaceId={workspaceId}>{content}</WorkspaceSocketProvider>
    );
    render(
      <QueryClientProvider client={queryClient}>
        {scope === null ? provider : <LocalCacheScopeProvider scope={scope}>{provider}</LocalCacheScopeProvider>}
      </QueryClientProvider>,
    );
    await flushPromises();
    // One socket for the Organization, and nothing else: no Channel socket.
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    return socket;
  }

  function children(queryClient: QueryClient): WorkstreamChildDirectory | undefined {
    return queryClient.getQueryData<WorkstreamChildDirectory>(['workstream-children', workstreamId]);
  }

  function railsSent(socket: FakeWebSocket): Record<string, unknown>[] {
    return socket.send.mock.calls
      .map(([frame]) => JSON.parse(String(frame)) as Record<string, unknown>)
      .filter((frame) => frame['type'] === 'channel_rails');
  }

  function railAnswer(requestId: unknown, railWaterline: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'workspace_channel_rails',
      requestId,
      rails: [{
        workstreamId, railWaterline, participantUserIds: [creator],
        sidekicks: { owned: [], recommended: [], attached: [] }, resources: [],
      }],
      oversized: [], unavailable: [], nextAfter: null, final: true,
      ...extra,
    };
  }

  it('asks for a Channel rail once its row says one, holds the answer, and asks again when the row moves it', async () => {
    const queryClient = new QueryClient();
    const socket = await connect(queryClient);
    act(() => socket.message(sidebarFrame({ railWaterline: 3 })));
    await flushPromises();
    const [first] = railsSent(socket);
    expect(first).toMatchObject({ workstreamIds: [workstreamId] });

    act(() => socket.message(railAnswer(first!['requestId'], 3)));
    await flushPromises();
    expect(queryClient.getQueryData(['channel-rail', workstreamId]))
      .toMatchObject({ railWaterline: 3, rail: { participantUserIds: [creator] } });
    expect(railsSent(socket)).toHaveLength(1);

    act(() => socket.message(stateFrame(8, { railWaterline: 4 })));
    await flushPromises();
    expect(railsSent(socket)).toHaveLength(2);
  });

  it('keeps a rail it was just answered when a row raises the waterline mid-request, and asks again', async () => {
    const queryClient = new QueryClient();
    const socket = await connect(queryClient);
    act(() => socket.message(sidebarFrame({ railWaterline: 5 })));
    await flushPromises();
    const [first] = railsSent(socket);

    // The attach that moved the rail lands before the answer does.
    act(() => socket.message(stateFrame(8, { railWaterline: 6 })));
    act(() => socket.message(railAnswer(first!['requestId'], 5)));
    await flushPromises();

    expect(queryClient.getQueryData(['channel-rail', workstreamId]))
      .toMatchObject({ railWaterline: 5, rail: { participantUserIds: [creator] } });
    const [, second] = railsSent(socket);
    expect(second).toMatchObject({ workstreamIds: [workstreamId] });
  });

  describe('loading Channels a Space at a time', () => {
    const general = '00000000-0000-4000-8000-000000000031';
    const design = '00000000-0000-4000-8000-000000000032';
    const other = '00000000-0000-7000-8000-000000000003';

    function spaceSent(socket: FakeWebSocket): Record<string, unknown>[] {
      return socket.send.mock.calls
        .map(([frame]) => JSON.parse(String(frame)) as Record<string, unknown>)
        .filter((frame) => frame['type'] === 'space_channels');
    }

    function spaceAnswer(
      requestId: unknown,
      rows: Record<string, unknown>[],
      nextAfter: string | null,
      rails: Record<string, unknown>[] = [],
    ): Record<string, unknown> {
      return {
        type: 'workspace_space_channels', requestId, directoryWaterline: 7, items: rows,
        stateVersions: rows.map((item) => ({ workstreamId: item['id'], ...version(7) })), rails, nextAfter,
      };
    }

    function bySpaceSidebar(): Record<string, unknown> {
      const frame = sidebarFrame({});
      const sidebar = frame['sidebar'] as Record<string, unknown>;
      return {
        ...frame,
        sidebar: {
          ...sidebar,
          workstreams: { directoryWaterline: 7, nextCursor: null, stateVersions: [], items: [] },
          channelsBySpace: true,
        },
      };
    }

    async function connectWithProbe(queryClient: QueryClient): Promise<{
      socket: FakeWebSocket;
      api: () => ReturnType<typeof useWorkspaceSocket>;
    }> {
      let current: ReturnType<typeof useWorkspaceSocket> | null = null;
      function Probe(): null {
        current = useWorkspaceSocket();
        return null;
      }
      const socket = await connect(queryClient, null, <Probe />);
      return { socket, api: () => current! };
    }

    it('asks the Space on screen alone, then every other Space at once, and takes rows and rails from each answer', async () => {
      const archive = '00000000-0000-4000-8000-000000000033';
      const queryClient = new QueryClient();
      queryClient.setQueryData(['spaces'], { waterline: 1, items: [{ id: general }, { id: design }] });
      queryClient.setQueryData(['spaces-inactive'], { waterline: 1, items: [{ id: archive }] });
      const { socket, api } = await connectWithProbe(queryClient);
      act(() => socket.message(bySpaceSidebar()));
      await flushPromises();
      expect(api().sidebarConnect?.channelsBySpace).toBe(true);

      act(() => api().prioritizeSpace(design));
      let walked!: Promise<Set<string> | null>;
      act(() => { walked = api().walkSpaceChannels(); });
      await flushPromises();
      // Alone until its first page is in.
      expect(spaceSent(socket)).toHaveLength(1);
      const [first] = spaceSent(socket);
      expect(first).toMatchObject({ spaceId: design, rails: true });
      expect(first).not.toHaveProperty('after');

      act(() => socket.message(spaceAnswer(first!['requestId'], [row({ spaceIds: [design], railWaterline: 2 })], workstreamId, [{
        workstreamId, railWaterline: 2, participantUserIds: [creator],
        sidekicks: { owned: [], recommended: [], attached: [] }, resources: [],
      }])));
      await flushPromises();
      // Painted as it lands, before the walk is over.
      expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.map((item) => item.id))
        .toEqual([workstreamId]);
      // Its next page, and every other Space, all in flight together.
      const inFlight = spaceSent(socket).slice(1);
      expect(inFlight.map((frame) => [frame['spaceId'], frame['after'] ?? null])).toEqual([
        [design, workstreamId], [general, null], [archive, null],
      ]);
      const [designNext, generalFirst, archiveFirst] = inFlight;
      // Answered out of order: each Space follows only its own pages.
      act(() => socket.message(spaceAnswer(archiveFirst!['requestId'], [], null)));
      act(() => socket.message(spaceAnswer(generalFirst!['requestId'], [row({ id: other, spaceIds: [general] })], null)));
      act(() => socket.message(spaceAnswer(designNext!['requestId'], [], null)));
      await expect(walked).resolves.toEqual(new Set([workstreamId, other]));
      await flushPromises();
      expect(spaceSent(socket)).toHaveLength(4);

      expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.map((item) => item.id).sort())
        .toEqual([workstreamId, other].sort());
      expect(queryClient.getQueryData(['channel-rail', workstreamId]))
        .toMatchObject({ railWaterline: 2, rail: { participantUserIds: [creator] } });
      // Set as each Space's walk ends, after the answer's `act` has returned,
      // so the render carrying it is the scheduler's, not `act`'s: wait for it.
      await vi.waitFor(() => expect(api().loadedSpaceIds).toEqual(new Set([design, general, archive])));
      // The rail came with its row, so nothing is asked for by name.
      expect(railsSent(socket)).toEqual([]);
    });

    it('keeps the rows it holds when the sidebar carries none, and leaves out rails it already holds', async () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['spaces'], { waterline: 1, items: [{ id: general }, { id: design }] });
      setCachedWorkstreams(queryClient, [summary({ id: workstreamId, spaceIds: [general] })]);
      queryClient.setQueryData(['channel-rail', workstreamId], { railWaterline: 1, rail: null });
      const { socket, api } = await connectWithProbe(queryClient);
      act(() => socket.message(bySpaceSidebar()));
      await flushPromises();
      expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.map((item) => item.id))
        .toEqual([workstreamId]);

      let walked!: Promise<Set<string> | null>;
      act(() => { walked = api().walkSpaceChannels(); });
      await flushPromises();
      const [first] = spaceSent(socket);
      expect(first).toMatchObject({ spaceId: general, rails: false });
      act(() => socket.message(spaceAnswer(first!['requestId'], [row({ spaceIds: [general] })], null)));
      await flushPromises();
      const [, second] = spaceSent(socket);
      expect(second).toMatchObject({ spaceId: design, rails: true });
      act(() => socket.message(spaceAnswer(second!['requestId'], [], null)));
      await expect(walked).resolves.toEqual(new Set([workstreamId]));
    });

    it('stops a walk a newer one replaced, before asking for another page', async () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['spaces'], { waterline: 1, items: [{ id: general }, { id: design }] });
      const { socket, api } = await connectWithProbe(queryClient);
      act(() => socket.message(bySpaceSidebar()));
      await flushPromises();
      const controller = new AbortController();
      let walked!: Promise<Set<string> | null>;
      act(() => { walked = api().walkSpaceChannels(controller.signal); });
      const settled = walked.then(() => 'resolved', () => 'rejected');
      await flushPromises();
      const [first] = spaceSent(socket);
      controller.abort();
      act(() => socket.message(spaceAnswer(first!['requestId'], [], null)));
      await expect(settled).resolves.toBe('rejected');
      expect(spaceSent(socket)).toHaveLength(1);
    });

    it('asks for a Space put on screen that no walk has returned, such as one created since', async () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['spaces'], { waterline: 1, items: [{ id: general }] });
      const { socket, api } = await connectWithProbe(queryClient);
      act(() => socket.message(bySpaceSidebar()));
      await flushPromises();
      let walked!: Promise<Set<string> | null>;
      act(() => { walked = api().walkSpaceChannels(); });
      await flushPromises();
      const [first] = spaceSent(socket);
      act(() => socket.message(spaceAnswer(first!['requestId'], [], null)));
      await walked;

      // Created after the walk, and opened.
      queryClient.setQueryData(['spaces'], { waterline: 2, items: [{ id: general }, { id: design }] });
      act(() => api().prioritizeSpace(design));
      await flushPromises();
      const [, created] = spaceSent(socket);
      expect(created).toMatchObject({ spaceId: design });
      act(() => socket.message(spaceAnswer(created!['requestId'], [], null)));
      await vi.waitFor(() => expect(api().loadedSpaceIds).toEqual(new Set([general, design])));
      // Loaded now: putting it on screen again asks nothing.
      act(() => api().prioritizeSpace(general));
      act(() => api().prioritizeSpace(design));
      await flushPromises();
      expect(spaceSent(socket)).toHaveLength(2);
    });

    it('asks only the Space on screen again when the directory moves, and the others when they come on screen', async () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['spaces'], { waterline: 1, items: [{ id: general }, { id: design }] });
      const { socket, api } = await connectWithProbe(queryClient);
      act(() => socket.message(bySpaceSidebar()));
      await flushPromises();
      act(() => api().prioritizeSpace(general));
      let walked!: Promise<Set<string> | null>;
      act(() => { walked = api().walkSpaceChannels(); });
      await flushPromises();
      act(() => socket.message(spaceAnswer(spaceSent(socket)[0]!['requestId'], [], null)));
      await flushPromises();
      act(() => socket.message(spaceAnswer(spaceSent(socket)[1]!['requestId'], [], null)));
      await walked;
      await flushPromises();
      expect(spaceSent(socket)).toHaveLength(2);

      // Somebody else pinned something: the directory moved.
      act(() => socket.message({
        type: 'workspace_sync', eventId: '00000000-0000-7000-8000-000000000018', waterline: 9,
        occurredAt: '2026-08-17T20:01:00.000Z', topics: ['workstream_directory'], reason: 'change',
      }));
      await flushPromises();
      expect(spaceSent(socket).slice(2).map((frame) => frame['spaceId'])).toEqual([general]);
      act(() => socket.message(spaceAnswer(spaceSent(socket)[2]!['requestId'], [], null)));
      await flushPromises();
      // Every Space stays loaded: what is held keeps painting.
      await vi.waitFor(() => expect(api().loadedSpaceIds).toEqual(new Set([general, design])));

      act(() => api().prioritizeSpace(design));
      await flushPromises();
      expect(spaceSent(socket).slice(3).map((frame) => frame['spaceId'])).toEqual([design]);
    });

    it('treats every Space as loading again when a reconnect\'s sidebar arrives', async () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['spaces'], { waterline: 1, items: [{ id: general }] });
      const { socket, api } = await connectWithProbe(queryClient);
      act(() => socket.message(bySpaceSidebar()));
      await flushPromises();
      let walked!: Promise<Set<string> | null>;
      act(() => { walked = api().walkSpaceChannels(); });
      await flushPromises();
      act(() => socket.message(spaceAnswer(spaceSent(socket)[0]!['requestId'], [], null)));
      await walked;
      await vi.waitFor(() => expect(api().loadedSpaceIds).toEqual(new Set([general])));

      act(() => socket.message(bySpaceSidebar()));
      await flushPromises();
      expect(api().loadedSpaceIds).toEqual(new Set());
    });

    it('walks nothing when the sidebar carried Channel rows', async () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['spaces'], { waterline: 1, items: [{ id: general }] });
      const { socket, api } = await connectWithProbe(queryClient);
      act(() => socket.message(sidebarFrame({ spaceIds: [general] })));
      await flushPromises();
      await expect(api().walkSpaceChannels()).resolves.toBeNull();
      expect(spaceSent(socket)).toEqual([]);
    });
  });

  it('asks for no rail when rows carry no rail waterline', async () => {
    const queryClient = new QueryClient();
    const socket = await connect(queryClient);
    act(() => socket.message(sidebarFrame({})));
    await flushPromises();
    expect(railsSent(socket)).toEqual([]);
  });

  it('takes the breakouts and running agents from the connect sidebar and keeps them with no screen open', async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const socket = await connect(queryClient);
    act(() => socket.message(sidebarFrame({
      privateChildren: [child(kept)], privateChildrenWaterline: 2, backgroundAgentCounts: { [kept]: 1 },
    })));
    // Nothing observes either entry, which is the Channel nobody has opened
    // yet. Default garbage collection would drop both after five minutes.
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(children(queryClient)?.privateChildren).toEqual([child(kept)]);
    expect(queryClient.getQueryData(['workstream-background-agents', workstreamId])).toEqual({ [kept]: 1 });
  });

  it('updates cached breakout resolution and removes archived breakouts from every navigation page using accepted rosters', async () => {
    const queryClient = new QueryClient();
    const socket = await connect(queryClient);
    const parent: SpaceConversationSummary = { ...mapWorkstreamSummary(WorkstreamSchema.parse(row())), kind: 'channel', breakoutOf: null };
    const breakout: SpaceConversationSummary = {
      ...parent, id: kept, kind: 'breakout', resolved: false,
      breakoutOf: { workstreamId, substreamId: kept, title: parent.title },
    };
    queryClient.setQueryData(MY_THREADS_QUERY_KEY, {
      pages: [{ items: [parent], pinned: [breakout], nextCursor: 'page-2' }, { items: [breakout], pinned: [], nextCursor: null }],
      pageParams: [null, 'page-2'],
    });
    const navigation = () => queryClient.getQueryData<InfiniteData<ThreadNavigationPage>>(MY_THREADS_QUERY_KEY)!;
    act(() => socket.message(stateFrame(5, { privateChildren: [child(kept)], privateChildrenWaterline: 1 })));
    // Resolution moves the roster's waterline independently of Main's state version.
    act(() => socket.message(stateFrame(5, { privateChildren: [child(kept, { resolved: true })], privateChildrenWaterline: 2 })));
    expect(navigation().pages[0]?.pinned?.[0]?.resolved).toBe(true);
    expect(navigation().pages[1]?.items[0]?.resolved).toBe(true);
    expect(reconcileThreadNavigationRows(queryClient, [breakout])[0]?.resolved).toBe(true);
    act(() => socket.message(stateFrame(6, { privateChildren: [], privateChildrenWaterline: 1 })));
    expect(navigation().pages[1]?.items).toHaveLength(1);
    act(() => socket.message(stateFrame(7, { privateChildren: [], privateChildrenWaterline: 3 })));
    expect(navigation().pages.map((page) => page.items.map((item) => item.id))).toEqual([[workstreamId], []]);
    expect(navigation().pages[0]?.pinned).toEqual([]);
    // A REST page requested before the archive cannot restore its older child row.
    expect(reconcileThreadNavigationRows(queryClient, [breakout])).toEqual([]);
  });

  it.each(['local archive', 'remote archive', 'membership loss'] as const)('reconciles navigation after a %s tombstone without treating every visibility loss as an archive', async (change) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const parent: SpaceConversationSummary = { ...mapWorkstreamSummary(WorkstreamSchema.parse(row())), kind: 'channel', breakoutOf: null };
    const breakout: SpaceConversationSummary = {
      ...parent, id: kept, kind: 'breakout',
      breakoutOf: { workstreamId, substreamId: kept, title: parent.title },
    };
    let authoritativeRows = [parent, breakout];
    queryClient.setQueryData(MY_THREADS_QUERY_KEY, { pages: [{ items: authoritativeRows, pinned: authoritativeRows, nextCursor: null }], pageParams: [null] });
    function Probe(): JSX.Element {
      const navigation = useQuery({
        queryKey: MY_THREADS_QUERY_KEY, staleTime: Infinity,
        queryFn: async () => ({ pages: [{ items: authoritativeRows, pinned: authoritativeRows, nextCursor: null }], pageParams: [null] }),
      });
      return <output data-testid="navigation-rows">{navigation.data?.pages.flatMap((page) => page.items.map((item) => item.id)).join(',') || 'none'}</output>;
    }
    const socket = await connect(queryClient, null, <Probe />);
    act(() => socket.message(stateFrame(5, { privateChildren: [child(kept)], privateChildrenWaterline: 1 })));
    if (change === 'local archive') {
      act(() => holdCachedWorkstreamArchive(queryClient, { ...parent, archivedAt: '2026-10-21T12:00:00.000Z' }));
      expect(queryClient.getQueryData<InfiniteData<ThreadNavigationPage>>(MY_THREADS_QUERY_KEY)?.pages[0]?.items).toEqual([]);
    }
    authoritativeRows = change === 'membership loss' ? [breakout] : [];
    act(() => socket.message(stateFrame(6, null)));
    if (change === 'local archive') {
      expect(queryClient.getQueryData<InfiniteData<ThreadNavigationPage>>(MY_THREADS_QUERY_KEY)?.pages[0]?.pinned).toEqual([]);
    }
    await vi.waitFor(() => expect(screen.getByTestId('navigation-rows').textContent).toBe(change === 'membership loss' ? kept : 'none'));
    const navigation = queryClient.getQueryData<InfiniteData<ThreadNavigationPage>>(MY_THREADS_QUERY_KEY)!;
    expect(navigation.pages[0]?.pinned?.map((item) => item.id)).toEqual(change === 'membership loss' ? [kept] : []);
    act(() => socket.message(stateFrame(5, {})));
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.some((item) => item.id === workstreamId)).not.toBe(true);
    expect(navigation.pages[0]?.items.some((item) => item.archivedAt)).toBe(false);
  });

  it('applies a pushed roster in waterline order and leaves it alone when a row does not say', async () => {
    const queryClient = new QueryClient();
    const socket = await connect(queryClient);
    act(() => socket.message(stateFrame(5, { privateChildren: [child(kept)], privateChildrenWaterline: 2 })));
    expect(children(queryClient)?.privateChildren).toEqual([child(kept)]);
    // Older roster: dropped on its own waterline even though the row is newer.
    act(() => socket.message(stateFrame(6, { privateChildren: [], privateChildrenWaterline: 1 })));
    expect(children(queryClient)?.privateChildren).toEqual([child(kept)]);
    // A row with no roster (an older server, or a parent not imported yet) is silent about it.
    act(() => socket.message(stateFrame(7, {})));
    expect(children(queryClient)?.privateChildren).toEqual([child(kept)]);
    act(() => socket.message(stateFrame(8, { privateChildren: [], privateChildrenWaterline: 3 })));
    expect(children(queryClient)?.privateChildren).toEqual([]);
  });

  it('evicts the roster and the running count when the Channel is withdrawn from this viewer', async () => {
    const queryClient = new QueryClient();
    const socket = await connect(queryClient);
    act(() => socket.message(stateFrame(5, {
      privateChildren: [child(kept)], privateChildrenWaterline: 2, backgroundAgentCounts: { '0': 2 },
    })));
    expect(children(queryClient)?.privateChildren).toHaveLength(1);
    // The revocation the control socket used to send as a 1008 close is the
    // row's tombstone here; the Organization socket stays open for the sidebar.
    act(() => socket.message(stateFrame(6, null)));
    expect(children(queryClient)).toBeUndefined();
    expect(queryClient.getQueryData(['workstream-background-agents', workstreamId])).toBeUndefined();
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('holds a receipt-backed breakout appearance until the parent projection catches up', async () => {
    const queryClient = new QueryClient();
    const socket = await connect(queryClient);
    const original = child(kept, { appearance: { icon: 'orbit', color: 'green' } });
    act(() => socket.message(stateFrame(4, { privateChildren: [original], privateChildrenWaterline: 2 })));
    applyBreakoutAppearanceReceipt(queryClient, workstreamId, kept, {
      baseline: { icon: 'orbit', color: 'green' },
      expected: { icon: 'orbit', color: 'purple' },
    });
    // An equal-waterline row may have been serialized before the receipt.
    act(() => socket.message(stateFrame(5, { privateChildren: [original], privateChildrenWaterline: 2 })));
    expect(children(queryClient)?.privateChildren?.[0]?.appearance).toEqual({ icon: 'orbit', color: 'purple' });
    expect(children(queryClient)?.appearanceOverlays).toHaveProperty(kept);
    const projected = child(kept, { appearance: { icon: 'orbit', color: 'purple' } });
    act(() => socket.message(stateFrame(6, { privateChildren: [projected], privateChildrenWaterline: 3 })));
    expect(children(queryClient)?.privateChildren?.[0]?.appearance).toEqual({ icon: 'orbit', color: 'purple' });
    expect(children(queryClient)?.appearanceOverlays).toBeUndefined();
  });

  it('forgets a cached breakout the roster no longer lists, and keeps the ones it does', async () => {
    const scope = 'global:00000000-0000-7000-8000-000000000001';
    await clearAllLocalCache();
    const cached = {
      detail: {
        ...summary({ id: workstreamId }), createdAt: '2026-08-17T18:00:00.000Z',
        participants: [], viewers: [], resources: [], connections: [], backgroundTasks: [],
      },
      transcript: {
        snapshotId: '00000000-0000-7000-8000-000000000777', snapshotThrough: 0, eventSequence: 0,
        snapshotAtUtc: '2026-08-17T19:00:00.000Z', unreadAnchorSequence: null, unreadReason: 'no_unread' as const,
        ranges: [], activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
      },
      initialContext: null,
      cachedAt: '',
    };
    for (const substreamId of ['0', kept, dropped]) {
      await conversationSlice.write(scope, conversationCacheKey(workstreamId, substreamId), cached, workstreamId);
    }
    const queryClient = new QueryClient();
    const socket = await connect(queryClient, scope);
    act(() => socket.message(stateFrame(4, { privateChildren: [child(kept)], privateChildrenWaterline: 2 })));
    const expected = [conversationCacheKey(workstreamId, '0'), conversationCacheKey(workstreamId, kept)].sort();
    await vi.waitFor(async () => {
      expect((await conversationSlice.entries(scope)).map((entry) => entry.key).sort()).toEqual(expected);
    }, { timeout: 2_000 });
    // A stale row the guard rejects lists nothing; the disk follows the kept roster.
    act(() => socket.message(stateFrame(5, { privateChildren: [], privateChildrenWaterline: 1 })));
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await conversationSlice.entries(scope)).map((entry) => entry.key).sort()).toEqual(expected);
  });
});

describe('the organization socket over the local cache', () => {
  const scope = 'global:00000000-0000-7000-8000-000000000001';
  const remembered = '00000000-0000-7000-8000-000000000002';
  const forgotten = '00000000-0000-7000-8000-000000000003';

  function syncPayload(ids: readonly string[]): Record<string, unknown> {
    return {
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000017',
      waterline: 4,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: ['workstream_directory'],
      reason: 'initial',
      sidebar: {
        workstreams: {
          directoryWaterline: 7,
          nextCursor: null,
          stateVersions: ids.map((id, index) => ({
            workstreamId: id,
            commonEventId: `00000000-0000-7000-8000-00000000001${index}`,
            viewerEventId: `00000000-0000-7000-8001-00000000001${index}`,
            authorityGeneration: 1,
            commonWaterline: 7,
            viewerWaterline: 4,
          })),
          items: ids.map((id) => ({
            id,
            workspaceId: '00000000-0000-7000-8000-000000000001',
            title: 'Live row',
            titleStatus: 'settled',
            objective: '',
            emailAddress: null,
            createdByUserId: null,
            harnessStatus: 'completed',
            latestAttentionSequenceNumber: 0,
            readThroughSequenceNumber: 0,
            manualUnreadFromSequenceNumber: null,
            manualUnreadGeneration: 0,
            hasUnread: false,
            youAreMentioned: false,
            firstUnreadSequenceNumber: null,
            lastActivityAt: '2026-08-17T20:00:00.000Z',
            createdAt: '2026-08-17T19:00:00.000Z',
            updatedAt: '2026-08-17T20:00:00.000Z',
            archivedAt: null,
            scope: 'workspace',
            systemKind: null,
            nextPendingWakeup: null,
            pinPosition: null,
            participantUserIds: [],
            participantExtraCount: 0,
            spaceIds: [],
          })),
        },
        automations: { waterline: 1, items: [] },
        notes: { waterline: 1, items: [], nextCursor: null },
      },
    };
  }

  it('paints the remembered sidebar before the socket connects, then takes the socket\'s, and forgets what it no longer lists', async () => {
    await clearAllLocalCache();
    await workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, {
      workstreams: [summary({ id: remembered, title: 'Remembered row' }), summary({ id: forgotten, title: 'Archived elsewhere' })],
      automations: [],
      spaces: { waterline: 2, items: [] },
      inactiveSpaces: { waterline: 2, items: [] },
      ordering: [],
      breakouts: {},
      rails: {},
    });
    const conversation = {
      detail: {
        ...summary({ id: remembered }), createdAt: '2026-08-17T19:00:00.000Z',
        participants: [], viewers: [], resources: [], connections: [], backgroundTasks: [],
      },
      transcript: {
        snapshotId: '00000000-0000-7000-8000-000000000777', snapshotThrough: 0, eventSequence: 0,
        snapshotAtUtc: '2026-08-17T19:00:00.000Z', unreadAnchorSequence: null, unreadReason: 'no_unread' as const,
        ranges: [], activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
      },
      initialContext: null,
      cachedAt: '',
    };
    await conversationSlice.write(scope, conversationCacheKey(remembered, '0'), conversation, remembered);
    await conversationSlice.write(scope, conversationCacheKey(forgotten, '0'), {
      ...conversation, detail: { ...conversation.detail, id: forgotten },
    }, forgotten);

    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <LocalCacheScopeProvider scope={scope}>
          <WorkspaceSocketProvider region="global"
            api={{ getWorkspaceSocketTicket }}
            workspaceId="00000000-0000-7000-8000-000000000001"
          >
            <div />
          </WorkspaceSocketProvider>
        </LocalCacheScopeProvider>
      </QueryClientProvider>,
    );

    // Before the socket has even opened, the sidebar has its rows.
    await vi.waitFor(() => {
      expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.map((row) => row.title))
        .toEqual(['Remembered row', 'Archived elsewhere']);
    }, { timeout: 2_000 });
    expect(queryClient.getQueryData(['spaces'])).toEqual({ waterline: 2, items: [] });
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING);

    act(() => socket.open());
    // Page one of a longer directory cannot say the missing row is gone:
    // it may simply be on a later page. Nothing leaves the disk on it.
    const pageOne = syncPayload([remembered]);
    const sidebar = pageOne['sidebar'] as { workstreams: Record<string, unknown> };
    act(() => socket.message({
      ...pageOne,
      sidebar: { ...sidebar, workstreams: { ...sidebar.workstreams, nextCursor: '1755460800000:00000000-0000-7000-8000-0000000000aa' } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await conversationSlice.entries(scope)).map((entry) => entry.key).sort())
      .toEqual([conversationCacheKey(forgotten, '0'), conversationCacheKey(remembered, '0')].sort());

    act(() => socket.message(syncPayload([remembered])));

    // The whole directory replaces the seed outright, and the conversation of
    // the row it no longer lists is gone from the disk.
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.map((row) => `${row.id}:${row.title}`))
      .toEqual([`${remembered}:Live row`]);
    await vi.waitFor(async () => {
      expect((await conversationSlice.entries(scope)).map((entry) => entry.key)).toEqual([conversationCacheKey(remembered, '0')]);
    }, { timeout: 2_000 });
    await vi.waitFor(async () => {
      const row = await workspaceDirectorySlice.read(scope, DIRECTORY_CACHE_KEY);
      expect(row?.workstreams.map((item) => item.title)).toEqual(['Live row']);
    }, { timeout: LOCAL_CACHE_WRITE_COALESCE_MS + 2_000 });
  });
  it('reads the meter again on every subscribe answer, and writes one pushed after a plan change into the read and the disk', async () => {
    await clearAllLocalCache();
    const queryClient = new QueryClient();
    const usageKey = organizationUsageQueryKey(scope);
    const starter = {
      plan: 'starter',
      quotaRemainingPercent: 10,
      weekResetsAt: '2026-10-08T09:00:00.000Z',
      overage: { amountMicrousd: 0, periodStart: '2026-10-01T09:00:00.000Z', periodEndsAt: '2026-11-01T09:00:00.000Z', billed: false },
    } as const;
    const growth = { ...starter, plan: 'growth', quotaRemainingPercent: 64 } as const;
    queryClient.setQueryData(usageKey, { usage: starter, fetchedAt: '2026-10-03T00:00:00.000Z' });
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <LocalCacheScopeProvider scope={scope}>
          <WorkspaceSocketProvider region="global"
            api={{ getWorkspaceSocketTicket }}
            workspaceId="00000000-0000-7000-8000-000000000001"
          >
            <div />
          </WorkspaceSocketProvider>
        </LocalCacheScopeProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    // A plan change made while this socket was away is not replayed.
    act(() => socket.message(syncPayload([])));
    expect(queryClient.getQueryState(usageKey)?.isInvalidated).toBe(true);

    act(() => socket.message({ type: 'workspace_usage', occurredAt: '2026-10-03T00:01:00.000Z', usage: growth }));
    expect(queryClient.getQueryData(usageKey)).toMatchObject({ usage: growth });
    await vi.waitFor(async () => {
      expect(await usageCacheSlice.read(scope, 'usage')).toMatchObject({ usage: growth });
    }, { timeout: LOCAL_CACHE_WRITE_COALESCE_MS + 2_000 });
  });
  it('keeps a pushed meter over a read that was already in flight when it arrived', async () => {
    await clearAllLocalCache();
    const queryClient = new QueryClient();
    const meter = (plan: 'starter' | 'growth', quotaRemainingPercent: number) => ({
      plan,
      quotaRemainingPercent,
      weekResetsAt: '2026-10-08T09:00:00.000Z',
      overage: { amountMicrousd: 0, periodStart: '2026-10-01T09:00:00.000Z', periodEndsAt: '2026-11-01T09:00:00.000Z', billed: false },
    } as const);
    let answerOldRead: (usage: ReturnType<typeof meter>) => void = () => undefined;
    const getWorkspaceUsage = vi.fn(() => new Promise<ReturnType<typeof meter>>((resolve) => { answerOldRead = resolve; }));
    const usageApi: OrganizationUsageApi = { getWorkspaceUsage };
    function Meter(): JSX.Element {
      const usage = useOrganizationUsage(usageApi);
      return <div>{usage.status === 'ready' ? `plan:${usage.reading.usage.plan}` : usage.status}</div>;
    }
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <LocalCacheScopeProvider scope={scope}>
          <WorkspaceSocketProvider region="global"
            api={{ getWorkspaceSocketTicket }}
            workspaceId="00000000-0000-7000-8000-000000000001"
          >
            <Meter />
          </WorkspaceSocketProvider>
        </LocalCacheScopeProvider>
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(getWorkspaceUsage).toHaveBeenCalledTimes(1));
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    act(() => socket.message({ type: 'workspace_usage', occurredAt: '2026-10-03T00:01:00.000Z', usage: meter('growth', 64) }));
    // The read started before the change answers with the plan it saw.
    await act(async () => { answerOldRead(meter('starter', 10)); await flushPromises(); });

    expect(await screen.findByText('plan:growth')).toBeInTheDocument();
    expect(queryClient.getQueryData(organizationUsageQueryKey(scope))).toMatchObject({ usage: { plan: 'growth' } });
    await new Promise((resolve) => setTimeout(resolve, LOCAL_CACHE_WRITE_COALESCE_MS + 100));
    expect(await usageCacheSlice.read(scope, 'usage')).toMatchObject({ usage: { plan: 'growth' } });
  });
});

describe('the organization-sync relay between windows', () => {
  const workspaceId = '00000000-0000-7000-8000-000000000001';
  const otherWorkspaceId = '00000000-0000-7000-8000-000000000009';
  const region = 'global';
  // A publisher left mounted by the previous test detaches during the
  // automatic cleanup, which runs after the file's own reset.
  beforeEach(() => {
    syncRelay.published = [];
  });
  const ticket = async () => ({
    url: 'wss://api.rally.test/socket/workspaces/workspace-1',
    ticket: 'workspace-ticket',
    protocols: socketTicketProtocols('workspace-ticket'),
  });

  function ConnectionProbe(): JSX.Element {
    const { state, topicWaterlines } = useWorkspaceSocket();
    return <div>{`${state}:${topicWaterlines.connector_oauth_attempts ?? '-'}`}</div>;
  }

  function publisher(identity: { region: string; workspaceId: string } = { region, workspaceId }): JSX.Element {
    return (
      <WorkspaceSocketProvider
        key={`${identity.region}:${identity.workspaceId}`}
        api={{ getWorkspaceSocketTicket: vi.fn(ticket) }}
        relay="publish"
        region={identity.region}
        workspaceId={identity.workspaceId}
      >
        <div />
      </WorkspaceSocketProvider>
    );
  }

  it('publishes the main window\'s state and every topic it hears, flag and Sidekick list pushes as their topics', async () => {
    const queryClient = new QueryClient();
    render(<QueryClientProvider client={queryClient}>{publisher()}</QueryClientProvider>);
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000008',
      waterline: 8,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: WORKSPACE_SYNC_TOPICS,
      reason: 'initial',
      sidebar: {
        workstreams: { directoryWaterline: 1, nextCursor: null, stateVersions: [], items: [] },
        automations: { waterline: 1, items: [] },
        notes: { waterline: 1, items: [], nextCursor: null },
      },
      featureFlags: { liveArtifactsEnabled: false },
    }));
    act(() => socket.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000009',
      waterline: 9,
      occurredAt: '2026-08-17T20:00:01.000Z',
      topics: ['member_directory'],
      reason: 'change',
    }));
    act(() => socket.message({
      type: 'workspace_feature_flags',
      occurredAt: '2026-08-17T20:00:02.000Z',
      changedFlag: 'live-artifacts-enabled',
      flags: ClientFeatureFlagsSchema.parse({ liveArtifactsEnabled: true }),
    }));
    act(() => socket.message({
      type: 'workspace_sidebar_list',
      occurredAt: '2026-08-17T20:00:03.000Z',
      list: 'automations',
      waterline: 2,
      items: [],
    }));
    act(() => socket.message({
      type: 'workspace_usage',
      occurredAt: '2026-08-17T20:00:04.000Z',
      usage: {
        plan: 'growth',
        quotaRemainingPercent: 64,
        weekResetsAt: '2026-08-20T20:00:00.000Z',
        overage: { amountMicrousd: 0, periodStart: '2026-08-01T20:00:00.000Z', periodEndsAt: '2026-09-01T20:00:00.000Z', billed: false },
      },
    }));
    await flushPromises();

    // `initial` is relayed whole: it names every topic because this socket
    // cannot say what moved before it subscribed, and neither can a consumer.
    // The flags themselves never cross; the consumer refetches its own.
    expect(syncRelay.published).toEqual([
      { type: 'state', region, workspaceId, state: 'connecting' },
      { type: 'state', region, workspaceId, state: 'connected' },
      // A meter push made while the socket was away is not replayed, so the
      // Settings window reads its own again on every subscribe answer.
      { type: 'topics', region, workspaceId, waterline: 8, topics: ['usage'] },
      { type: 'topics', region, workspaceId, waterline: 8, topics: [...WORKSPACE_SYNC_TOPICS] },
      { type: 'topics', region, workspaceId, waterline: 9, topics: ['member_directory'] },
      { type: 'topics', region, workspaceId, waterline: 9, topics: ['feature_flags'] },
      // The Sidekicks window reads what the list push refetches, not the list.
      { type: 'topics', region, workspaceId, waterline: 9, topics: ['automations'] },
      // The meter travels by value on the socket and by name on the relay.
      { type: 'topics', region, workspaceId, waterline: 9, topics: ['usage'] },
    ]);
  });

  it('detaches when its provider unmounts with no successor, and not when one replaces it', async () => {
    const queryClient = new QueryClient();
    const other = { region, workspaceId: otherWorkspaceId };
    const view = render(<QueryClientProvider client={queryClient}>{publisher()}</QueryClientProvider>);
    await flushPromises();

    // An Organization switch: the successor attaches, and the predecessor
    // sends nothing that would leave main with no publisher in between.
    view.rerender(<QueryClientProvider client={queryClient}>{publisher(other)}</QueryClientProvider>);
    await flushPromises();
    expect(syncRelay.published).toEqual([
      { type: 'state', region, workspaceId, state: 'connecting' },
      { type: 'state', region, workspaceId: otherWorkspaceId, state: 'connecting' },
    ]);

    // The tree falls into the error boundary: nothing replaces it.
    view.rerender(<QueryClientProvider client={queryClient}><div /></QueryClientProvider>);
    await flushPromises();
    expect(syncRelay.published.slice(2)).toEqual([{ type: 'detach', region, workspaceId: otherWorkspaceId }]);
  });

  it('does not detach across StrictMode\'s mount, unmount and mount', async () => {
    render(<StrictMode><QueryClientProvider client={new QueryClient()}>{publisher()}</QueryClientProvider></StrictMode>);
    await flushPromises();
    expect(syncRelay.published.some((publication) => publication.type === 'detach')).toBe(false);
    expect(syncRelay.published.at(-1)).toEqual({ type: 'state', region, workspaceId, state: 'connecting' });
  });

  it('holds no socket while the main window publishes, and applies what it relays', async () => {
    syncRelay.snapshot = { revision: 3, source: { region, workspaceId, state: 'connected' } };
    const queryClient = new QueryClient();
    const readMembers = vi.fn(async () => ['member']);
    const readFlags = vi.fn(async () => ClientFeatureFlagsSchema.parse({}));
    const readUsage = vi.fn(async () => 'usage');
    const getWorkspaceSocketTicket = vi.fn(ticket);
    function Reads(): JSX.Element {
      useQuery({ queryKey: ['workspace-usage', null], queryFn: readUsage, staleTime: 30_000, networkMode: 'always' });
      const members = useQuery({
        queryKey: ['workspace-members'], queryFn: readMembers, staleTime: 30_000, networkMode: 'always',
      });
      useQuery({ queryKey: ['feature-flags'], queryFn: readFlags, staleTime: 30_000, networkMode: 'always' });
      return <div>{members.data?.join(',') ?? 'loading'}</div>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider api={{ getWorkspaceSocketTicket }} relay="consume" region={region} workspaceId={workspaceId}>
          <ConnectionProbe />
          <Reads />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('connected:-')).toBeInTheDocument();
    expect(await screen.findByText('member')).toBeInTheDocument();
    await flushPromises();

    // One read on open, and no socket: nothing in this window asks for a
    // ticket, so no `initial` arrives to repeat the read.
    expect(getWorkspaceSocketTicket).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(readMembers).toHaveBeenCalledTimes(1);
    expect(readFlags).toHaveBeenCalledTimes(1);

    // A change the main window's socket hears reaches this window's reads.
    relayToConsumer({
      type: 'topics', region, workspaceId, waterline: 12, topics: ['member_directory', 'connector_oauth_attempts'],
    });
    await vi.waitFor(() => expect(readMembers).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(await screen.findByText('connected:12')).toBeInTheDocument();

    // A flag change is a topic like any other: this window reads its own.
    relayToConsumer({ type: 'topics', region, workspaceId, waterline: 12, topics: ['feature_flags'] });
    await vi.waitFor(() => expect(readFlags).toHaveBeenCalledTimes(2), { timeout: 2_000 });

    // A plan change: this window has no socket, so it reads its own meter.
    expect(readUsage).toHaveBeenCalledTimes(1);
    relayToConsumer({ type: 'topics', region, workspaceId, waterline: 12, topics: ['usage'] });
    await vi.waitFor(() => expect(readUsage).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(await screen.findByText('connected:12')).toBeInTheDocument();

    // News about another Organization is not this window's — including the
    // same UUID in another region.
    relayToConsumer({ type: 'topics', region, workspaceId: otherWorkspaceId, waterline: 13, topics: ['member_directory'] });
    relayToConsumer({ type: 'topics', region: 'enterprise', workspaceId, waterline: 13, topics: ['member_directory'] });
    await flushPromises();
    expect(readMembers).toHaveBeenCalledTimes(2);

    // The publisher's connection state is what this window reports.
    relayToConsumer({ type: 'source', revision: 4, source: { region, workspaceId, state: 'reconnecting' } });
    expect(await screen.findByText('reconnecting:12')).toBeInTheDocument();
  });

  it('dials its own socket only while nobody publishes, and puts it down when somebody does', async () => {
    syncRelay.snapshot = { revision: 0, source: null };
    const getWorkspaceSocketTicket = vi.fn(ticket);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceSocketProvider api={{ getWorkspaceSocketTicket }} relay="consume" region={region} workspaceId={workspaceId}>
          <ConnectionProbe />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 2_000 });
    const own = FakeWebSocket.instances[0]!;
    act(() => own.open());
    expect(await screen.findByText('connected:-')).toBeInTheDocument();

    // The main window comes back and publishes: this window's socket closes.
    relayToConsumer({ type: 'source', revision: 1, source: { region, workspaceId, state: 'connecting' } });
    expect(own.readyState).toBe(FakeWebSocket.CLOSED);
    expect(await screen.findByText('connecting:-')).toBeInTheDocument();

    // A stale answer cannot undo a newer event.
    relayToConsumer({ type: 'source', revision: 0, source: null });
    await flushPromises();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // The main window's provider goes: this window subscribes afresh, from
    // nothing, so its first answer names every topic and covers the hand-over.
    relayToConsumer({ type: 'source', revision: 2, source: null });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 2_000 });
    const replacement = FakeWebSocket.instances[1]!;
    act(() => replacement.open());
    expect(JSON.parse(replacement.send.mock.calls[0]![0] as string)).toMatchObject({ type: 'subscribe', afterWaterline: 0 });
    // It relays nothing: only the main window publishes.
    expect(syncRelay.published).toEqual([]);
  });

  it('waits, holding no socket, while the publisher serves another Organization, and takes over from it', async () => {
    // The same UUID in another region: the main window is mid-switch.
    syncRelay.snapshot = { revision: 5, source: { region: 'enterprise', workspaceId, state: 'connected' } };
    const getWorkspaceSocketTicket = vi.fn(ticket);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceSocketProvider api={{ getWorkspaceSocketTicket }} relay="consume" region={region} workspaceId={workspaceId}>
          <ConnectionProbe />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    // Not the other Organization's state: this window has no connection yet.
    expect(await screen.findByText('connecting:-')).toBeInTheDocument();
    await flushPromises();
    expect(getWorkspaceSocketTicket).not.toHaveBeenCalled();

    relayToConsumer({ type: 'source', revision: 6, source: { region, workspaceId, state: 'connected' } });
    expect(await screen.findByText('connected:-')).toBeInTheDocument();
    expect(getWorkspaceSocketTicket).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
