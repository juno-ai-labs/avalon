import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamSocketApi } from './use-workstream-socket';
import {
  RECENT_WORKSTREAM_SOCKET_RETENTION_MS,
  WorkstreamSocketPool,
  useRetainedWorkstreamSocket,
} from './workstream-socket-pool';

const workspaceCreateMessage = vi.hoisted(() => vi.fn());
vi.mock('./workspace-socket', () => ({
  useWorkspaceSocket: () => ({
    state: 'connected',
    createMessage: workspaceCreateMessage,
  }),
}));

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly send = vi.fn();
  readonly close = vi.fn((code = 1000) => {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  });
  readyState = FakeWebSocket.CONNECTING;

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
  ) {
    super();
    FakeWebSocket.instances.push(this);
  }
}

function createWrapper(): ({ children }: PropsWithChildren) => React.JSX.Element {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function socketApi(): WorkstreamSocketApi & {
  getSocketTicket: ReturnType<typeof vi.fn>;
  getWorkstreamControlSocketTicket: ReturnType<typeof vi.fn>;
} {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected socket API call.');
  };
  return {
    getMessages: vi.fn(unexpected),
    getSocketTicket: vi.fn(async (workstreamId: string) => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}/feed`,
      ticket: `feed-ticket-${workstreamId}`,
      protocols: socketTicketProtocols(`feed-ticket-${workstreamId}`),
    })),
    getWorkstreamControlSocketTicket: vi.fn(async (workstreamId: string) => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}/control`,
      ticket: `control-ticket-${workstreamId}`,
      protocols: socketTicketProtocols(`control-ticket-${workstreamId}`),
    })),
    getWorkstream: vi.fn(unexpected),
    messageMentionPayload: vi.fn(async () => []),
  };
}

function ActiveConnection({
  api,
  enabled,
  workstreamId,
}: {
  api: WorkstreamSocketApi;
  enabled: boolean;
  workstreamId: string;
}): React.JSX.Element {
  const connection = useRetainedWorkstreamSocket(api, workstreamId, enabled);
  return <div>{connection.state}</div>;
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
  workspaceCreateMessage.mockReset();
  FakeWebSocket.instances = [];
});

describe('WorkstreamSocketPool', () => {
  it('does not admit a route whose initial reads failed, including after navigation', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000631';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000632';
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={firstWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled={false} workstreamId={firstWorkstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );
    await flushPromises();

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled={false} workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    act(() => vi.advanceTimersByTime(RECENT_WORKSTREAM_SOCKET_RETENTION_MS));

    expect(api.getSocketTicket).not.toHaveBeenCalled();
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('reuses the exact feed and control socket pair until retention expires', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000633';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000634';
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={firstWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={firstWorkstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );
    await flushPromises();
    const firstPair = FakeWebSocket.instances.filter((socket) => String(socket.url).includes(firstWorkstreamId));
    expect(firstPair.map((socket) => String(socket.url))).toEqual([
      `wss://api.rally.test/workstreams/${firstWorkstreamId}/control`,
      `wss://api.rally.test/workstreams/${firstWorkstreamId}/feed`,
    ]);

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    expect(api.getSocketTicket).toHaveBeenCalledTimes(2);
    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(2);
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);

    act(() => vi.advanceTimersByTime(RECENT_WORKSTREAM_SOCKET_RETENTION_MS - 1));
    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={firstWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={firstWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();

    expect(api.getSocketTicket).toHaveBeenCalledTimes(2);
    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances.filter((socket) => String(socket.url).includes(firstWorkstreamId)))
      .toEqual(firstPair);
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    act(() => vi.advanceTimersByTime(RECENT_WORKSTREAM_SOCKET_RETENTION_MS));
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
  });
});
