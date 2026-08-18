import { WORKSPACE_SYNC_TOPICS } from '@avalon/contracts';
import { socketTicketProtocols } from '@avalon/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSocketProvider, useWorkspaceSocket } from './workspace-socket';

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
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterVersion: 0 }));

    act(() => socket.message({
      type: 'workspace_sync',
      version: 8,
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
      version: 12,
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
    expect(second.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterVersion: 12 }));
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
});
