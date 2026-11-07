import {
  ClientFeatureFlagsSchema,
  asSubstreamId,
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSPACE_SYNC_TOPICS,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
} from '@rally/contracts';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { onlineManager, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { StrictMode, useEffect, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSocketProvider, useWorkspaceSocket } from './workspace-socket';
import { clearAllLocalCache } from './local-cache';
import { LOCAL_CACHE_WRITE_COALESCE_MS } from './local-cache-mirror';
import { LocalCacheScopeProvider } from './local-cache-scope';
import { organizationUsageQueryKey, usageCacheSlice, useOrganizationUsage, type OrganizationUsageApi } from './organization-usage';
import { requestSocketTicket, SOCKET_TICKET_REQUEST_TIMEOUT_MS } from './socket-ticket-request';
import { WORKSPACE_SOCKET_OPEN_TIMEOUT_MS } from '@rally/contracts/workspace-reach-watch';

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
    topics: ['automations'], reason: 'initial',
    sidebar: {
      automations: { waterline: 0, items: [] },
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
      telemetryCause: 'access_revoked',
    },
    {
      closeCode: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
      telemetryCause: 'server_closed',
    },
    {
      closeCode: WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
      telemetryCause: 'server_closed',
    },
  ])('stops for good on close code $closeCode, says why, and does not reconnect', async ({
    closeCode,
    telemetryCause,
  }) => {
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
          <div />
        </WorkspaceSocketProvider>
      </QueryClientProvider>,
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    reportTelemetryProductIntent.mockClear();

    act(() => socket.close(closeCode));
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
    const runsKey = ['automation-runs', 'idle-automation'];
    queryClient.setQueryData(runsKey, []);
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
      ['automation'],
      ['automation-draft'],
      ['automation-runs'],
      ['sidekicks-library'],
      ['resources'],
      ['workstream-context'],
      ['telemetry-preference'],
      ['feature-flags'],
    ]) expect(invalidatedRoots).toContain(JSON.stringify(root));
    expect(queryClient.getQueryState(runsKey)?.isInvalidated).toBe(true);
    // The two sidebar lists are pushed whole, so a topic must never invalidate
    // them: nothing would refetch, and naming them here would suggest otherwise.
    for (const pushed of [['automations'], ['canvases']]) {
      expect(invalidatedRoots).not.toContain(JSON.stringify(pushed));
    }
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
      topics: ['automations'],
      reason: 'initial',
      sidebar: {
        automations: { waterline: 0, items: [] },
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
      topics: ['automations'],
      reason: 'initial',
      featureFlags: {
        developerSettings: false,
        suggestedWorkEnabled: false,
        controlTowerRefreshSeconds: 60,
      },
      sidebar: {
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
      },
    }));

    // Painted from a frame nobody asked for.
    expect(queryClient.getQueryData(['automations']))
      .toEqual([expect.objectContaining({ id: '00000000-0000-7000-8000-000000000005', scope: 'workspace' })]);
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
    const keys = ['automations', 'feature-flags'].map((key) => [key]);
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

  it('refetches an open automation page when its list row is pushed', async () => {
    const queryClient = new QueryClient();
    const automationId = '00000000-0000-7000-8000-000000000005';
    queryClient.setQueryData(['automation', automationId], { id: automationId, currentDefinition: null });
    queryClient.setQueryData(['automation-runs', automationId], []);
    queryClient.setQueryData(['sidekicks-library'], []);
    queryClient.setQueryData(['sidekick-activity', 'workstream', 'room', '0'], 0);
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

    // The skew this is about: a Canvas row from an API that predates a
    // field this build requires.
    act(() => socket.message({
      type: 'workspace_canvas_list',
      occurredAt: '2026-08-27T00:01:00.000Z',
      waterline: 4,
      items: [{ id: '00000000-0000-7000-8000-0000000000f2' }],
    }));

    expect(queryClient.getQueryData(['canvases'])).toBeUndefined();
    const line = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(line).toContain('canvas list');
    expect(line).toContain('title');

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
});

describe('the organization socket over the local cache', () => {
  const scope = 'global:00000000-0000-7000-8000-000000000001';

  function syncPayload(): Record<string, unknown> {
    return {
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000017',
      waterline: 4,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: ['automations'],
      reason: 'initial',
      sidebar: {
        automations: { waterline: 1, items: [] },
      },
    };
  }

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
    act(() => socket.message(syncPayload()));
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
        automations: { waterline: 1, items: [] },
      },
      featureFlags: { suggestedWorkEnabled: false },
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
      changedFlag: 'suggested-work-enabled',
      flags: ClientFeatureFlagsSchema.parse({ suggestedWorkEnabled: true }),
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
      // A consuming window reads what the list push refetches, not the list.
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
