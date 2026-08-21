import { WORKSPACE_SYNC_TOPICS } from '@avalon/contracts';
import { socketTicketProtocols } from '@avalon/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamSummary } from './types';
import { useWorkstreamControlSocket } from './use-workstream-control-socket';
import { WorkspaceSocketProvider, useWorkspaceSocket } from './workspace-socket';
import { setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

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
  FakeWebSocket.instances = [];
});

describe('WorkspaceSocketProvider', () => {
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
      ['automations'],
      ['automation'],
      ['automation-draft'],
      ['notes'],
      ['note'],
      ['resources'],
      ['workstream-context'],
      ['work-opportunities'],
      ['workstreams'],
      ['telemetry-preference'],
      ['block-dashboard-preference'],
      ['feature-flags'],
    ]) expect(invalidatedRoots).toContain(JSON.stringify(root));
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
