import {
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSPACE_SYNC_TOPICS,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
} from '@rally/contracts';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { useEffect, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamSummary } from './types';
import { useWorkstreamControlSocket } from './use-workstream-control-socket';
import { WorkspaceSocketProvider, useWorkspaceSocket } from './workspace-socket';
import { setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import { conversationCacheKey, conversationSlice } from './conversation-cache';
import { clearAllLocalCache } from './local-cache';
import { LOCAL_CACHE_WRITE_COALESCE_MS } from './local-cache-mirror';
import { LocalCacheScopeProvider } from './local-cache-scope';
import { DIRECTORY_CACHE_KEY, workspaceDirectorySlice } from './workspace-directory-cache';

import type * as TelemetryModule from './telemetry';

const reportTelemetryProductIntent = vi.hoisted(() => vi.fn());
const applicationFocus = vi.hoisted(() => ({
  foregrounded: false,
  listeners: new Set<(foregrounded: boolean) => void>(),
}));
vi.mock('./telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof TelemetryModule>(),
  reportTelemetryProductIntent,
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
    observeClientFeatureFlags: async () => undefined,
  }),
}));

function setApplicationForeground(foregrounded: boolean): void {
  applicationFocus.foregrounded = foregrounded;
  for (const listener of applicationFocus.listeners) listener(foregrounded);
}

/** Every `realtime_socket_state` this test reported, in order. */
function socketTelemetry(): unknown[] {
  return reportTelemetryProductIntent.mock.calls
    .map(([intent]) => intent as { kind: string })
    .filter((intent) => intent.kind === 'realtime_socket_state');
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
    this.readyState = FakeWebSocket.CLOSED;
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
  reportTelemetryProductIntent.mockClear();
  applicationFocus.foregrounded = false;
  applicationFocus.listeners.clear();
  FakeWebSocket.instances = [];
  vi.restoreAllMocks();
});

describe('WorkspaceSocketProvider', () => {
  it('reports app and work-stream foreground separately and receives viewer-scoped presence', async () => {
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
        <WorkspaceSocketProvider
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
        <WorkspaceSocketProvider
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
        <WorkspaceSocketProvider
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

  it('notifies the session owner when the active workspace revokes access', async () => {
    const queryClient = new QueryClient();
    const onAccessRevoked = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider
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
      message: 'You can no longer access this workspace.',
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
        <WorkspaceSocketProvider
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

  it('keeps one workspace socket, subscribes durably, and invalidates every workspace surface', async () => {
    const queryClient = new QueryClient();
    const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider
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
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterWaterline: 0 }));

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
      ['github-repository-access'],
      ['terminal-workspace-settings'],
      ['digest-schedule'],
      ['automation'],
      ['automation-draft'],
      ['sidekicks-library'],
      ['attached-sidekicks'],
      ['note'],
      ['resources'],
      ['workstream-context'],
      ['work-opportunities'],
      ['workstreams'],
      ['telemetry-preference'],
      ['feature-flags'],
    ]) expect(invalidatedRoots).toContain(JSON.stringify(root));
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
      changedFlag: 'meeting-recording-enabled',
      flags: {
        developerSettings: false,
        meetingRecordingEnabled: true,
        controlTowerRefreshSeconds: 60,
      },
    }));
    expect(queryClient.getQueryData(['feature-flags'])).toMatchObject({ meetingRecordingEnabled: true });
  });

  it('reports how deep a workspace reconnect had to go, and stops reporting at teardown', async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider
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
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
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

  it('calls an offline transition during the ticket request what it is', async () => {
    const queryClient = new QueryClient();
    let releaseTicket: (() => void) | null = null;
    const getWorkspaceSocketTicket = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseTicket = resolve; });
      return {
        url: 'wss://api.rally.test/socket/workspaces/workspace-1',
        ticket: 'workspace-ticket',
        protocols: socketTicketProtocols('workspace-ticket'),
      };
    });
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div>connected surface</div>
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();

    // The desktop drops off the network while the ticket is still in flight, so
    // the offline handler finds no socket to close and records nothing.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    releaseTicket!();
    await flushPromises();

    // Dialling anyway would have produced a transport error a moment later, and
    // counted an ordinary walk out of Wi-Fi range as a broken connection.
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(socketTelemetry()).toEqual([{
      kind: 'realtime_socket_state',
      socket: 'workspace',
      state: 'stopped',
      cause: 'offline',
      attempts: 'zero',
    }]);
  });

  it('names the cause a workspace close event cannot carry', async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider
          api={{ getWorkspaceSocketTicket }}
          workspaceId="00000000-0000-7000-8000-000000000001"
        >
          <div>connected surface</div>
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
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
    render(<QueryClientProvider client={queryClient}><WorkspaceSocketProvider
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

  it('pages the authoritative work-stream directory over the workspace socket', async () => {
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
        <WorkspaceSocketProvider
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
      }],
    }));
    await expect(result).resolves.toMatchObject({
      nextCursor: null,
      items: [{ id: '00000000-0000-7000-8000-000000000002', title: 'Socket-owned directory' }],
    });
  });

  it('paints the whole sidebar from the subscribe answer, without asking for it', async () => {
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider
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
        meetingRecordingEnabled: false,
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

    // All three painted from a frame nobody asked for.
    expect(queryClient.getQueryData(['workstreams']))
      .toEqual([expect.objectContaining({ id: '00000000-0000-7000-8000-000000000002' })]);
    expect(queryClient.getQueryData(['automations']))
      .toEqual([expect.objectContaining({ id: '00000000-0000-7000-8000-000000000005', scope: 'workspace' })]);
    expect(queryClient.getQueryData(['notes']))
      .toEqual([expect.objectContaining({ id: '00000000-0000-7000-8000-000000000006', title: 'Standup' })]);
    expect(queryClient.getQueryData(['feature-flags']))
      .toMatchObject({ meetingRecordingEnabled: false });

    // The point of the payload: the only thing the client said was where it
    // had got to. A directory request here would be the round trip this frame
    // exists to remove.
    const sent = socket.send.mock.calls.map(([frame]) => JSON.parse(String(frame)) as { type: string });
    expect(sent.map((frame) => frame.type)).toEqual(['subscribe', 'set_presence']);
  });

  it('does not ask for the directory it was just handed', async () => {
    const queryClient = new QueryClient();
    const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider
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
        <WorkspaceSocketProvider
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
        <WorkspaceSocketProvider
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
        <WorkspaceSocketProvider
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

  it('refetches an open automation page when its list row is pushed', async () => {
    const queryClient = new QueryClient();
    const automationId = '00000000-0000-7000-8000-000000000005';
    queryClient.setQueryData(['automation', automationId], { id: automationId, currentDefinition: null });
    queryClient.setQueryData(['automation-runs', automationId], []);
    queryClient.setQueryData(['sidekicks-library'], []);
    queryClient.setQueryData(['attached-sidekicks', 'room'], []);
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider
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
    expect(queryClient.getQueryState(['attached-sidekicks', 'room'])?.isInvalidated).toBe(true);
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
        <WorkspaceSocketProvider
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

  it('applies active and archived project state from the socket and drops an older snapshot', async () => {
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider
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

    const project = {
      id: '00000000-0000-7000-8000-0000000000f2',
      name: 'Hiring',
      iconKey: 'briefcase',
      colorKey: 'blue',
      scope: 'personal',
      status: 'active',
      presentationRevision: 1,
      audienceGeneration: 1,
      lifecycleGeneration: 1,
      participants: [],
      workstreamIds: [],
      defaultResourceIds: [],
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    };
    act(() => socket.message({
      type: 'workspace_project_snapshot',
      occurredAt: '2026-08-27T00:01:00.000Z',
      projects: {
        active: { waterline: 4, items: [project] },
        inactive: { waterline: 4, items: [] },
      },
    }));
    expect(queryClient.getQueryData(['projects'])).toEqual({ waterline: 4, items: [project] });
    expect(queryClient.getQueryData(['projects-inactive'])).toEqual({ waterline: 4, items: [] });

    act(() => socket.message({
      type: 'workspace_project_snapshot',
      occurredAt: '2026-08-27T00:02:00.000Z',
      projects: {
        active: { waterline: 3, items: [] },
        inactive: { waterline: 3, items: [{ ...project, status: 'archived' }] },
      },
    }));
    expect(queryClient.getQueryData(['projects'])).toEqual({ waterline: 4, items: [project] });
    expect(queryClient.getQueryData(['projects-inactive'])).toEqual({ waterline: 4, items: [] });
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
        <WorkspaceSocketProvider
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

describe('the workspace and work-stream sockets over one store', () => {
  /**
   * Both sockets carry the same state change, and both write it into the one
   * waterline ledger. That redundancy is the point: whichever authority
   * reaches this client first updates it, and the copy that arrives second is
   * ignored on its waterline rather than by anyone knowing which socket it
   * came from. These two tests exist because nothing else pins the seam —
   * the ledger is covered with synthetic calls and each socket is covered
   * alone, so a handler that stopped populating a real `stateVersion` would
   * pass every one of them and reintroduce the flicker on the surface.
   */
  const workstreamId = '00000000-0000-7000-8000-000000000002';
  const workspaceId = '00000000-0000-7000-8000-000000000001';

  function controlMetadata(waterline: number): Record<string, unknown> {
    return {
      stateVersion: {
        commonEventId: '00000000-0000-7000-8000-000000000007',
        viewerEventId: '00000000-0000-7000-8001-000000000004',
        authorityGeneration: 1,
        commonWaterline: waterline,
        viewerWaterline: 4,
      },
      revision: waterline,
      id: workstreamId,
      workspaceId,
      title: 'Finished',
      description: 'Objective',
      preview: 'Preview',
      emailAddress: null,
      createdByUserId: null,
      titleStatus: 'settled',
      exactState: 'completed',
      harnessStatus: 'completed',
      latestAttentionSequenceNumber: 4,
      unreadTrackingStartSequenceNumber: 0,
      lastActivityAt: '2026-08-17T20:00:00.000Z',
      completedAt: '2026-08-17T20:00:00.000Z',
      archivedAt: null,
      createdAt: '2026-08-17T19:00:00.000Z',
      updatedAt: '2026-08-17T20:00:00.000Z',
      scope: 'workspace',
      systemKind: null,
      nextPendingWakeup: null,
      nextTerminalActionAt: null,
      viewer: {
        isParticipant: true,
        listable: true,
        unreadCount: 0,
        youAreMentioned: false,
        readThroughSequenceNumber: 2,
        manualUnreadFromSequenceNumber: null,
        manualUnreadGeneration: 0,
        latestMentionSequenceNumber: 0,
      },
    };
  }

  function workspaceStateFrame(waterline: number, harnessStatus: string): Record<string, unknown> {
    return {
      type: 'workspace_workstream_state',
      occurredAt: '2026-08-17T20:00:00.000Z',
      workstreamId,
      stateVersion: {
        commonEventId: '00000000-0000-7000-8000-000000000007',
        viewerEventId: '00000000-0000-7000-8001-000000000004',
        authorityGeneration: 1,
        commonWaterline: waterline,
        viewerWaterline: 4,
      },
      workstream: {
        id: workstreamId,
        workspaceId,
        title: 'Finished',
        titleStatus: 'settled',
        objective: 'Objective',
        emailAddress: null,
        createdByUserId: null,
        harnessStatus,
        latestAttentionSequenceNumber: 4,
        readThroughSequenceNumber: 2,
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
      },
    };
  }

  async function renderBothSockets(queryClient: QueryClient): Promise<{
    workspaceSocket: FakeWebSocket;
    controlSocket: FakeWebSocket;
  }> {
    const api = {
      getWorkspaceSocketTicket: vi.fn(async () => ({
        url: 'wss://api.rally.test/socket/workspaces/workspace-1',
        ticket: 'workspace-ticket',
        protocols: socketTicketProtocols('workspace-ticket'),
      })),
      getWorkstreamControlSocketTicket: vi.fn(async () => ({
        url: 'wss://api.rally.test/socket/workstreams/control',
        ticket: 'control-ticket',
        protocols: socketTicketProtocols('control-ticket'),
      })),
    };
    function ControlSocket(): null {
      useWorkstreamControlSocket(api, workstreamId, true);
      return null;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSocketProvider api={api} workspaceId={workspaceId}>
          <ControlSocket />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    // Selected by URL, not by index: the two hooks each await their own ticket
    // and the order they reach the constructor is not the order they mount in.
    const socketFor = (marker: string): FakeWebSocket => {
      const found = FakeWebSocket.instances.find((instance) => String(instance.url).includes(marker));
      if (!found) throw new Error(`no socket opened for ${marker}`);
      return found;
    };
    const workspaceSocket = socketFor('/workspaces/');
    const controlSocket = socketFor('/workstreams/');
    act(() => workspaceSocket.open());
    act(() => controlSocket.open());
    await flushPromises();
    return { workspaceSocket, controlSocket };
  }

  function storedStatus(queryClient: QueryClient): string | undefined {
    return queryClient.getQueryData<{ id: string; harnessStatus: string }[]>(WORKSTREAMS_QUERY_KEY)
      ?.find((item) => item.id === workstreamId)?.harnessStatus;
  }

  it('takes the transition from whichever socket reports it first', async () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary({ id: workstreamId, harnessStatus: 'running' })]);
    const { workspaceSocket, controlSocket } = await renderBothSockets(queryClient);

    // The work-stream socket wins the race.
    act(() => controlSocket.message({
      type: 'workstream_metadata',
      occurredAt: '2026-08-17T20:00:00.000Z',
      metadata: controlMetadata(7),
    }));
    expect(storedStatus(queryClient)).toBe('completed');

    // The workspace socket's copy of the same change lands afterwards. It is
    // dropped on its waterline, and the value it would have written is not
    // what makes that safe — this frame deliberately disagrees, so a store
    // that applied it would read 'running' again.
    act(() => workspaceSocket.message(workspaceStateFrame(7, 'running')));
    expect(storedStatus(queryClient)).toBe('completed');
  });

  it('takes it from the other socket when that one arrives first', async () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary({ id: workstreamId, harnessStatus: 'running' })]);
    const { workspaceSocket, controlSocket } = await renderBothSockets(queryClient);

    // The order this change made likely: WorkspaceDO is pushed eagerly now, so
    // the sidebar copy can beat the work stream's own socket.
    act(() => workspaceSocket.message(workspaceStateFrame(7, 'completed')));
    expect(storedStatus(queryClient)).toBe('completed');

    act(() => controlSocket.message({
      type: 'workstream_metadata',
      occurredAt: '2026-08-17T20:00:00.000Z',
      metadata: { ...controlMetadata(7), harnessStatus: 'running', exactState: 'running' },
    }));
    expect(storedStatus(queryClient)).toBe('completed');
  });
});

describe('the workspace socket over the local cache', () => {
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
      notes: [],
      projects: { waterline: 2, items: [] },
      inactiveProjects: { waterline: 2, items: [] },
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
          <WorkspaceSocketProvider
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
    expect(queryClient.getQueryData(['projects'])).toEqual({ waterline: 2, items: [] });
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
});
