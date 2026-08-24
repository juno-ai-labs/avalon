import {
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSPACE_SYNC_TOPICS,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
} from '@avalon/contracts';
import { socketTicketProtocols } from '@avalon/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamSummary } from './types';
import { useWorkstreamControlSocket } from './use-workstream-control-socket';
import { WorkspaceSocketProvider, useWorkspaceSocket } from './workspace-socket';
import { setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

import type * as TelemetryModule from './telemetry';

const reportTelemetryProductIntent = vi.hoisted(() => vi.fn());
vi.mock('./telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof TelemetryModule>(),
  reportTelemetryProductIntent,
}));

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
    origin: 'ad_hoc',
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  reportTelemetryProductIntent.mockClear();
  FakeWebSocket.instances = [];
});

describe('WorkspaceSocketProvider', () => {
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
      message: 'Avalon could not complete this action because its realtime command was invalid. Restart the app and try again.',
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
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    let createMessage: ReturnType<typeof useWorkspaceSocket>['createMessage'] | null = null;
    function Probe(): null {
      const workspaceSocket = useWorkspaceSocket();
      useEffect(() => {
        createMessage = workspaceSocket.createMessage;
      }, [workspaceSocket.createMessage]);
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
      result = createMessage!({
        type: 'create_message',
        workstreamId: '00000000-0000-7000-8000-000000000002',
        substreamId: '0',
        operationId: '00000000-0000-7000-8000-000000000003',
        payload: {
          text: 'Send once',
          clientMessageId: 'client-message-close-code',
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      });
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
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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
      ['note'],
      ['resources'],
      ['workstream-context'],
      ['work-opportunities'],
      ['workstreams'],
      ['telemetry-preference'],
      ['block-dashboard-preference'],
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
  });

  it('resends one idempotent message command after reconnect and resumes the sync cursor', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    }));
    let createMessage: ReturnType<typeof useWorkspaceSocket>['createMessage'] | null = null;
    function Probe(): null {
      const workspaceSocket = useWorkspaceSocket();
      useEffect(() => {
        createMessage = workspaceSocket.createMessage;
      }, [workspaceSocket.createMessage]);
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
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.message({
      type: 'workspace_sync',
      eventId: '00000000-0000-7000-8000-000000000012',
      waterline: 12,
      occurredAt: '2026-08-17T20:00:00.000Z',
      topics: ['workspace_profile'],
      reason: 'change',
    }));
    const command = {
      type: 'create_message' as const,
      workstreamId: '00000000-0000-7000-8000-000000000002',
      substreamId: '0' as const,
      operationId: '00000000-0000-7000-8000-000000000003',
      payload: {
        text: 'Continue from another window.',
        clientMessageId: 'client-message-1',
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    };
    let result: Promise<unknown> | null = null;
    act(() => {
      result = createMessage!(command);
    });
    expect(first.send).toHaveBeenCalledWith(JSON.stringify(command));

    act(() => first.close(1012));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await flushPromises();
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    expect(second.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterWaterline: 12 }));
    expect(second.send).toHaveBeenCalledWith(JSON.stringify(command));

    act(() => second.message({
      type: 'client_command_succeeded',
      command: 'create_message',
      clientMessageId: 'client-message-1',
      message: {
        id: '00000000-0000-7000-8000-000000000004',
        clientMessageId: 'client-message-1',
        workspaceId: '00000000-0000-7000-8000-000000000001',
        workstreamId: command.workstreamId,
        sequenceNumber: 2,
        author: { type: 'system' },
        messageType: 'text',
        textContent: command.payload.text,
        structuredContent: null,
        mentions: [],
        attachments: [],
        createdAt: '2026-08-17T20:00:01.000Z',
        editedAt: null,
      },
      agentInvoked: false,
      harnessRunId: null,
    }));
    await expect(result).resolves.toMatchObject({
      clientMessageId: 'client-message-1',
      text: command.payload.text,
    });
  });

  it('reports how deep a workspace reconnect had to go, and stops reporting at teardown', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    let releaseTicket: (() => void) | null = null;
    const getWorkspaceSocketTicket = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseTicket = resolve; });
      return {
        url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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

  it('pages the authoritative work-stream directory over the workspace socket', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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
        originType: 'ad_hoc',
        originLabel: null,
        createdByUserId: '00000000-0000-7000-8000-000000000003',
        automationSubscriptionId: null,
        automationRunId: null,
        plannedFor: null,
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
      }],
    }));
    await expect(result).resolves.toMatchObject({
      nextCursor: null,
      items: [{ id: '00000000-0000-7000-8000-000000000002', title: 'Socket-owned directory' }],
    });
  });

  it('paints the whole sidebar from the subscribe answer, without asking for it', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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
          originType: 'ad_hoc',
          originLabel: null,
          createdByUserId: '00000000-0000-7000-8000-000000000003',
          automationSubscriptionId: null,
          automationRunId: null,
          plannedFor: null,
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
        updateAvailable: false,
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

    // The point of the payload: the only thing the client said was where it
    // had got to. A directory request here would be the round trip this frame
    // exists to remove.
    const sent = socket.send.mock.calls.map(([frame]) => JSON.parse(String(frame)) as { type: string });
    expect(sent.map((frame) => frame.type)).toEqual(['subscribe']);
  });

  it('does not ask for the directory it was just handed', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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
    vi.stubGlobal('WebSocket', FakeWebSocket);
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
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, () => [summary({
      id: '00000000-0000-7000-8000-0000000000ff',
      title: 'Archived while the socket was away',
    })]);
    const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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
        updateAvailable: false,
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

  it('drops a sidebar list whose version is not newer than the one applied', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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
        updateAvailable: false,
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

  it('fails an in-flight directory page immediately when the desktop goes offline', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    let online = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    const queryClient = new QueryClient();
    const getWorkspaceSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
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
      originType: 'ad_hoc',
      createdByUserId: null,
      automationSubscriptionId: null,
      automationRunId: null,
      plannedFor: null,
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
        originType: 'ad_hoc',
        originLabel: null,
        createdByUserId: null,
        automationSubscriptionId: null,
        automationRunId: null,
        plannedFor: null,
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
      },
    };
  }

  async function renderBothSockets(queryClient: QueryClient): Promise<{
    workspaceSocket: FakeWebSocket;
    controlSocket: FakeWebSocket;
  }> {
    const api = {
      getWorkspaceSocketTicket: vi.fn(async () => ({
        url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
        ticket: 'workspace-ticket',
        protocols: socketTicketProtocols('workspace-ticket'),
      })),
      getWorkstreamControlSocketTicket: vi.fn(async () => ({
        url: 'wss://api.avalon.test/socket/workstreams/control',
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
    vi.stubGlobal('WebSocket', FakeWebSocket);
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
    vi.stubGlobal('WebSocket', FakeWebSocket);
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
