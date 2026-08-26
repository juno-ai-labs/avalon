import type { BlockDashboardPreference, WorkstreamControlMetadata } from '@rally/contracts';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamSummary } from './types';
import { useWorkstreamControlSocket } from './use-workstream-control-socket';
import { setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

import type * as TelemetryModule from './telemetry';
import { cancelWorkstreamFeedOpen, markWorkstreamFeedOpenStarted } from './telemetry';

const reportTelemetryProductIntent = vi.hoisted(() => vi.fn());
vi.mock('./telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof TelemetryModule>(),
  reportTelemetryProductIntent,
}));

function socketTelemetry(): unknown[] {
  return reportTelemetryProductIntent.mock.calls
    .map(([intent]) => intent as { kind: string })
    .filter((intent) => intent.kind === 'realtime_socket_state');
}

function socketStartedTelemetry(): Array<Record<string, unknown>> {
  return reportTelemetryProductIntent.mock.calls
    .map(([intent]) => intent as Record<string, unknown>)
    .filter((intent) => intent['kind'] === 'workstream_socket_started');
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

  message(metadata: WorkstreamControlMetadata): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      type: 'workstream_metadata',
      occurredAt: '2026-08-17T20:00:00.000Z',
      metadata,
    }) }));
  }

  event(value: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
}

const workstreamId = '00000000-0000-7000-8000-000000000011';
const workspaceId = '00000000-0000-7000-8000-000000000012';

function summary(overrides: Partial<WorkstreamSummary> = {}): WorkstreamSummary {
  return {
    id: workstreamId,
    title: 'Before sync',
    titleStatus: 'settled',
    origin: 'ad_hoc',
    harnessStatus: 'completed',
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
    ...overrides,
  };
}

function metadata(revision: number, overrides: Partial<WorkstreamControlMetadata> = {}): WorkstreamControlMetadata {
  return {
    stateVersion: {
      commonEventId: `00000000-0000-7000-8000-${revision.toString(16).padStart(12, '0')}`,
      viewerEventId: `00000000-0000-7000-8001-${revision.toString(16).padStart(12, '0')}`,
      authorityGeneration: 1,
      commonWaterline: revision,
      viewerWaterline: revision,
    },
    revision,
    id: workstreamId,
    workspaceId,
    title: 'Authoritative title',
    description: 'Authoritative description',
    preview: 'Preview',
    emailAddress: 'workstream@automation.rallywith.ai',
    originType: 'ad_hoc',
    createdByUserId: '00000000-0000-7000-8000-000000000013',
    automationSubscriptionId: null,
    automationRunId: null,
    plannedFor: null,
    titleStatus: 'settled',
    exactState: 'running',
    harnessStatus: 'running',
    latestAttentionSequenceNumber: 7,
    unreadTrackingStartSequenceNumber: 1,
    lastActivityAt: '2026-08-17T20:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-08-17T18:00:00.000Z',
    updatedAt: '2026-08-17T20:00:00.000Z',
    scope: 'workspace',
    systemKind: null,
    nextPendingWakeup: null,
    nextTerminalActionAt: null,
    viewer: {
      blockDashboardPreference: { visible: false, updatedAt: null },
      isParticipant: true,
      listable: true,
      unreadCount: 3,
      youAreMentioned: true,
      unseen: false,
      readThroughSequenceNumber: 4,
      manualUnreadFromSequenceNumber: null,
      manualUnreadGeneration: 2,
      latestMentionSequenceNumber: 7,
    },
    ...overrides,
  };
}

function wrapper(queryClient: QueryClient): ({ children }: PropsWithChildren) => React.JSX.Element {
  return function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  reportTelemetryProductIntent.mockClear();
  FakeWebSocket.instances = [];
});

describe('useWorkstreamControlSocket', () => {
  it('applies complete versioned metadata, clears nullable values, and drops revoked rows', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary({
      emailAddress: 'stale@example.com',
      automationRunId: '00000000-0000-7000-8000-000000000099',
      systemKind: 'digest',
    })]);
    const getWorkstreamControlSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/socket/workstreams/${workstreamId}`,
      ticket: 'control-ticket',
      protocols: socketTicketProtocols('control-ticket'),
    }));
    renderHook(
      () => useWorkstreamControlSocket({ getWorkstreamControlSocketTicket }, workstreamId, true),
      { wrapper: wrapper(queryClient) },
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe' }));

    act(() => socket.message(metadata(4)));
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]).toMatchObject({
      title: 'Authoritative title',
      objective: 'Authoritative description',
      harnessStatus: 'running',
      hasUnread: true,
      youAreMentioned: true,
      firstUnreadSequenceNumber: 5,
    });

    act(() => socket.message(metadata(3, { title: 'Stale title' })));
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.title)
      .toBe('Authoritative title');

    act(() => socket.message(metadata(5, {
      emailAddress: null,
      createdByUserId: null,
      automationRunId: null,
      archivedAt: null,
      systemKind: null,
    })));
    const cleared = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0];
    expect(cleared).not.toHaveProperty('emailAddress', 'stale@example.com');
    expect(cleared?.emailAddress).toBeUndefined();
    expect(cleared?.automationRunId).toBeUndefined();
    expect(cleared?.systemKind).toBeUndefined();

    act(() => socket.close(1008));
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)).toEqual([]);
  });

  it('opens a fresh ticket and requests a complete snapshot after a transient close', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getWorkstreamControlSocketTicket = vi.fn(async (id: string, requestId?: string) => {
      void id;
      void requestId;
      return {
        url: `wss://api.rally.test/socket/workstreams/${workstreamId}`,
        ticket: 'control-ticket',
        protocols: socketTicketProtocols('control-ticket'),
      };
    });
    const openAttemptId = markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold', 0);
    renderHook(
      () => useWorkstreamControlSocket(
        { getWorkstreamControlSocketTicket }, workstreamId, true, 'hover_warmup',
      ),
      { wrapper: wrapper(queryClient) },
    );
    await flushPromises();
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.close(1012));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    await flushPromises();
    expect(getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(2);
    const started = socketStartedTelemetry();
    expect(started).toHaveLength(2);
    expect(new Set(started.map((intent) => intent['socketLeaseId']))).toHaveLength(1);
    expect(started[0]?.['socketLeaseId']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(started.map(({ operationId, ...intent }) => {
      expect(operationId).toMatch(/^[0-9a-f-]{36}$/u);
      delete intent['socketLeaseId'];
      return intent;
    })).toEqual([
      {
        kind: 'workstream_socket_started', workstreamId, socket: 'workstream_control',
        openAttemptId, reason: 'hover_warmup', attempts: 'zero',
      },
      {
        kind: 'workstream_socket_started', workstreamId, socket: 'workstream_control',
        openAttemptId, reason: 'reconnect', attempts: 'one',
      },
    ]);
    expect(getWorkstreamControlSocketTicket.mock.calls.map((call) => call[1]))
      .toEqual(started.map((intent) => intent['operationId']));
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    expect(second.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe' }));
    cancelWorkstreamFeedOpen(workstreamId, 100);
  });

  it('reports its own connections under the control socket rather than the feed', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getWorkstreamControlSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/socket/workstreams/${workstreamId}`,
      ticket: 'control-ticket',
      protocols: socketTicketProtocols('control-ticket'),
    }));
    renderHook(
      () => useWorkstreamControlSocket({ getWorkstreamControlSocketTicket }, workstreamId, true),
      { wrapper: wrapper(queryClient) },
    );
    await flushPromises();
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.close(1012));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await flushPromises();
    act(() => FakeWebSocket.instances[1]!.open());

    // Two sockets serve one open work stream, and they fail independently:
    // reporting both under one name would make either one's drop rate wrong.
    expect(socketTelemetry()).toEqual([
      {
        kind: 'realtime_socket_state',
        socket: 'workstream_control',
        state: 'connected',
        cause: 'opened',
        attempts: 'zero',
      },
      {
        kind: 'realtime_socket_state',
        socket: 'workstream_control',
        state: 'retrying',
        cause: 'server_closed',
        attempts: 'zero',
      },
      {
        kind: 'realtime_socket_state',
        socket: 'workstream_control',
        state: 'connected',
        cause: 'opened',
        attempts: 'one',
      },
    ]);
  });

  it('stops rather than retries when the room says the reader lost access', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary()]);
    queryClient.setQueryData(['messages', workstreamId], [{ sensitive: true }]);
    queryClient.setQueryData(['block-dashboard', workstreamId], { blocks: [{ sensitive: true }] });
    queryClient.setQueryData(['block-dashboard-preference', workstreamId], { visible: true });
    const getWorkstreamControlSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/socket/workstreams/${workstreamId}`,
      ticket: 'control-ticket',
      protocols: socketTicketProtocols('control-ticket'),
    }));
    renderHook(
      () => useWorkstreamControlSocket({ getWorkstreamControlSocketTicket }, workstreamId, true),
      { wrapper: wrapper(queryClient) },
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    reportTelemetryProductIntent.mockClear();
    act(() => socket.close(1008));

    expect(socketTelemetry()).toEqual([{
      kind: 'realtime_socket_state',
      socket: 'workstream_control',
      state: 'stopped',
      cause: 'access_revoked',
      attempts: 'zero',
    }]);
    expect(queryClient.getQueryData(['messages', workstreamId])).toBeUndefined();
    expect(queryClient.getQueryData(['block-dashboard', workstreamId])).toBeUndefined();
    expect(queryClient.getQueryData(['block-dashboard-preference', workstreamId])).toBeUndefined();
  });

  it('applies HyperSight configuration and personal visibility from WorkstreamDO', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getWorkstreamControlSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/socket/workstreams/${workstreamId}`,
      ticket: 'control-ticket',
      protocols: socketTicketProtocols('control-ticket'),
    }));
    renderHook(
      () => useWorkstreamControlSocket({ getWorkstreamControlSocketTicket }, workstreamId, true),
      { wrapper: wrapper(queryClient) },
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const blockId = '00000000-0000-7000-8000-000000000014';
    const versionId = '00000000-0000-7000-8000-000000000015';
    act(() => socket.event({
      type: 'block_dashboard_configuration_updated',
      occurredAt: '2026-08-17T20:00:00.000Z',
      blockDashboard: {
        versionId,
        versionNumber: 1,
        updatedAt: '2026-08-17T20:00:00.000Z',
        blocks: [{ id: blockId, prompt: 'Summarize', latestRun: null }],
      },
    }));
    act(() => socket.event({
      type: 'block_dashboard_preference_updated',
      occurredAt: '2026-08-17T20:00:02.000Z',
      preference: { visible: true, updatedAt: '2026-08-17T20:00:02.000Z' },
    }));

    expect(queryClient.getQueryData(['block-dashboard', workstreamId]))
      .toMatchObject({ blocks: [{ latestRun: null }] });
    expect(queryClient.getQueryData<BlockDashboardPreference>(['block-dashboard-preference', workstreamId]))
      .toEqual({ visible: true, updatedAt: '2026-08-17T20:00:02.000Z' });
  });

  it('logs the first malformed control frame without logging its payload', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getWorkstreamControlSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/socket/workstreams/${workstreamId}`,
      ticket: 'control-ticket',
      protocols: socketTicketProtocols('control-ticket'),
    }));
    renderHook(
      () => useWorkstreamControlSocket(
        { getWorkstreamControlSocketTicket },
        workstreamId,
        true,
      ),
      { wrapper: wrapper(new QueryClient()) },
    );
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.event({ privatePayload: 'do-not-log' }));
    act(() => socket.event({ another: 'malformed-frame' }));

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain('Ignored invalid WorkstreamDO socket event');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('do-not-log');
  });
});
