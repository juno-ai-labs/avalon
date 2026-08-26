import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render } from '@testing-library/react';
import { useEffect, type PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamSocketApi } from './use-workstream-socket';
import {
  RECENT_WORKSTREAM_SOCKET_RETENTION_MS,
  WorkstreamSocketPool,
  retainedWorkstreamSocketIds,
  useRetainedWorkstreamSocket,
  useWorkstreamSocketHoverWarmup,
  useWorkstreamSocketOpenContext,
  type WorkstreamSocketOpenContext,
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

function HoverWarmTarget({
  onRender,
  workstreamId,
}: {
  onRender?: () => void;
  workstreamId: string;
}): React.JSX.Element {
  onRender?.();
  const warmup = useWorkstreamSocketHoverWarmup(workstreamId);
  return <button {...warmup}>Warm work stream</button>;
}

function OpenContextTarget({
  onRead,
  workstreamId,
}: {
  onRead: (context: WorkstreamSocketOpenContext) => void;
  workstreamId: string;
}): React.JSX.Element {
  const readOpenContext = useWorkstreamSocketOpenContext(workstreamId);
  return <button onClick={() => onRead(readOpenContext())}>Read pool context</button>;
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
  vi.restoreAllMocks();
  workspaceCreateMessage.mockReset();
  FakeWebSocket.instances = [];
});

describe('retainedWorkstreamSocketIds', () => {
  it('deduplicates active, background, recent, and just-left membership in priority order', () => {
    expect(retainedWorkstreamSocketIds('active', ['active', 'running'], ['running', 'recent'], 'recent'))
      .toEqual(['active', 'running', 'recent']);
  });

  it('returns no IDs when every source is empty', () => {
    expect(retainedWorkstreamSocketIds(null, [], [], null)).toEqual([]);
  });
});

describe('WorkstreamSocketPool', () => {
  it('opens and retains only the control socket after a one-second hover', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const workstreamId = '00000000-0000-7000-8000-000000000630';
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={null} api={api} backgroundWorkstreamIds={[]}>
        <HoverWarmTarget workstreamId={workstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );
    const target = view.getByRole('button', { name: 'Warm work stream' });

    fireEvent.pointerEnter(target);
    act(() => vi.advanceTimersByTime(999));
    fireEvent.pointerLeave(target);
    act(() => vi.advanceTimersByTime(1));
    await flushPromises();
    expect(api.getSocketTicket).not.toHaveBeenCalled();
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();

    fireEvent.pointerEnter(target);
    act(() => vi.advanceTimersByTime(1_000));
    await flushPromises();
    expect(api.getSocketTicket).not.toHaveBeenCalled();
    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(1);
    const warmedSockets = FakeWebSocket.instances.filter(
      (socket) => String(socket.url).includes(workstreamId),
    );
    expect(warmedSockets.map((socket) => String(socket.url))).toEqual([
      `wss://api.rally.test/workstreams/${workstreamId}/control`,
    ]);

    fireEvent.pointerLeave(target);
    act(() => vi.advanceTimersByTime(RECENT_WORKSTREAM_SOCKET_RETENTION_MS - 1));
    expect(warmedSockets.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(warmedSockets.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
  });

  it('adds the feed without reopening the warmed control socket after navigation succeeds', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const workstreamId = '00000000-0000-7000-8000-000000000639';
    const onReadContext = vi.fn();
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={null} api={api} backgroundWorkstreamIds={[]}>
        <HoverWarmTarget workstreamId={workstreamId} />
        <ActiveConnection api={api} enabled={false} workstreamId={workstreamId} />
        <OpenContextTarget onRead={onReadContext} workstreamId={workstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );

    fireEvent.click(view.getByRole('button', { name: 'Read pool context' }));
    expect(onReadContext).toHaveBeenLastCalledWith({ state: 'cold' });

    fireEvent.pointerEnter(view.getByRole('button', { name: 'Warm work stream' }));
    act(() => vi.advanceTimersByTime(1_000));
    await flushPromises();
    const warmedControl = FakeWebSocket.instances[0];
    if (!warmedControl) throw new Error('The hovered work stream opened no control socket.');
    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(1);
    expect(api.getSocketTicket).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Read pool context' }));
    const warmedContext = onReadContext.mock.lastCall?.[0] as WorkstreamSocketOpenContext;
    expect(warmedContext).toEqual({
      state: 'control_warmup',
      socketLeaseId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={workstreamId} api={api} backgroundWorkstreamIds={[]}>
        <HoverWarmTarget workstreamId={workstreamId} />
        <ActiveConnection api={api} enabled workstreamId={workstreamId} />
        <OpenContextTarget onRead={onReadContext} workstreamId={workstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();

    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(1);
    expect(api.getSocketTicket).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.map((socket) => String(socket.url))).toEqual([
      `wss://api.rally.test/workstreams/${workstreamId}/control`,
      `wss://api.rally.test/workstreams/${workstreamId}/feed`,
    ]);
    expect(FakeWebSocket.instances[0]).toBe(warmedControl);
    expect(warmedControl.close).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Read pool context' }));
    expect(onReadContext).toHaveBeenLastCalledWith({
      state: 'retained_pair',
      socketLeaseId: warmedContext.socketLeaseId,
    });
  });

  it('keeps at most one unopened control socket warm', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000640';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000641';
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={null} api={api} backgroundWorkstreamIds={[]}>
        <HoverWarmTarget workstreamId={firstWorkstreamId} />
        <HoverWarmTarget workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );
    const targets = view.getAllByRole('button', { name: 'Warm work stream' });
    const firstTarget = targets[0];
    const secondTarget = targets[1];
    if (!firstTarget || !secondTarget) throw new Error('Expected two hover targets.');

    fireEvent.pointerEnter(firstTarget);
    act(() => vi.advanceTimersByTime(1_000));
    await flushPromises();
    const firstControl = FakeWebSocket.instances[0];
    if (!firstControl) throw new Error('The first hovered work stream opened no control socket.');

    fireEvent.pointerEnter(secondTarget);
    act(() => vi.advanceTimersByTime(1_000));
    await flushPromises();

    expect(api.getSocketTicket).not.toHaveBeenCalled();
    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(2);
    expect(firstControl.close).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances[1]?.close).not.toHaveBeenCalled();
  });

  it('does not rerender hover consumers when a pooled connection changes state', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const activeWorkstreamId = '00000000-0000-7000-8000-000000000645';
    const rendered = vi.fn();
    render(
      <WorkstreamSocketPool activeWorkstreamId={activeWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={activeWorkstreamId} />
        <HoverWarmTarget onRender={rendered} workstreamId="another-workstream" />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );
    await flushPromises();
    const rendersBeforeConnectionChange = rendered.mock.calls.length;
    const feedSocket = FakeWebSocket.instances.find((socket) => String(socket.url).endsWith('/feed'));
    if (!feedSocket) throw new Error('The active work stream opened no feed socket.');

    act(() => {
      feedSocket.readyState = FakeWebSocket.OPEN;
      feedSocket.dispatchEvent(new Event('open'));
    });
    await flushPromises();

    expect(rendered).toHaveBeenCalledTimes(rendersBeforeConnectionChange);
  });

  it('does not add a hover warm-up beyond the active socket pair', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const workstreamId = '00000000-0000-7000-8000-000000000642';
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={workstreamId} api={api} backgroundWorkstreamIds={[]}>
        <HoverWarmTarget workstreamId={workstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );

    fireEvent.pointerEnter(view.getByRole('button', { name: 'Warm work stream' }));
    act(() => vi.advanceTimersByTime(1_001));
    await flushPromises();

    expect(api.getSocketTicket).toHaveBeenCalledTimes(1);
    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending warm-up when the row unmounts', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const workstreamId = '00000000-0000-7000-8000-000000000643';
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={null} api={api} backgroundWorkstreamIds={[]}>
        <HoverWarmTarget workstreamId={workstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );

    fireEvent.pointerEnter(view.getByRole('button', { name: 'Warm work stream' }));
    act(() => vi.advanceTimersByTime(500));
    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={null} api={api} backgroundWorkstreamIds={[]} />,
    );
    act(() => vi.advanceTimersByTime(501));
    await flushPromises();

    expect(api.getSocketTicket).not.toHaveBeenCalled();
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
  });

  it('replaces a pending warm-up with the active socket pair', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const workstreamId = '00000000-0000-7000-8000-000000000644';
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={null} api={api} backgroundWorkstreamIds={[]}>
        <HoverWarmTarget workstreamId={workstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );

    fireEvent.pointerEnter(view.getByRole('button', { name: 'Warm work stream' }));
    act(() => vi.advanceTimersByTime(500));
    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={workstreamId} api={api} backgroundWorkstreamIds={[]}>
        <HoverWarmTarget workstreamId={workstreamId} />
      </WorkstreamSocketPool>,
    );
    act(() => vi.advanceTimersByTime(501));
    await flushPromises();

    expect(api.getSocketTicket).toHaveBeenCalledTimes(1);
    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(1);
  });

  it('keeps the route subtree mounted while the active work stream changes', () => {
    const mounted = vi.fn();
    function Route({ workstreamId }: { workstreamId: string }): React.JSX.Element {
      useEffect(() => {
        mounted();
      }, []);
      return <div>{workstreamId}</div>;
    }
    const api = socketApi();
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId="first" api={api} backgroundWorkstreamIds={[]}>
        <Route workstreamId="first" />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId="second" api={api} backgroundWorkstreamIds={[]}>
        <Route workstreamId="second" />
      </WorkstreamSocketPool>,
    );

    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it('opens each active route feed without waiting for descendant admission', async () => {
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

    expect(api.getSocketTicket).toHaveBeenCalledTimes(2);
    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances.map((socket) => String(socket.url))).toEqual([
      `wss://api.rally.test/workstreams/${firstWorkstreamId}/control`,
      `wss://api.rally.test/workstreams/${firstWorkstreamId}/feed`,
      `wss://api.rally.test/workstreams/${secondWorkstreamId}/control`,
      `wss://api.rally.test/workstreams/${secondWorkstreamId}/feed`,
    ]);
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

  it('keeps a background-running socket pair past the recent-view deadline', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000635';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000636';
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={firstWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={firstWorkstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );
    await flushPromises();
    const firstPair = FakeWebSocket.instances.filter((socket) => String(socket.url).includes(firstWorkstreamId));

    view.rerender(
      <WorkstreamSocketPool
        activeWorkstreamId={secondWorkstreamId}
        api={api}
        backgroundWorkstreamIds={[firstWorkstreamId]}
      >
        <ActiveConnection api={api} enabled workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    act(() => vi.advanceTimersByTime(RECENT_WORKSTREAM_SOCKET_RETENTION_MS));
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
  });

  it('re-arms expiry when the wall clock moves backward before the timer fires', async () => {
    const startedAt = new Date('2026-08-25T12:00:00.000Z').getTime();
    vi.useFakeTimers({ now: startedAt });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000637';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000638';
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={firstWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={firstWorkstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );
    await flushPromises();
    const firstPair = FakeWebSocket.instances.filter((socket) => String(socket.url).includes(firstWorkstreamId));
    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();

    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt - 60_000);
    act(() => vi.advanceTimersByTime(RECENT_WORKSTREAM_SOCKET_RETENTION_MS));
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);

    now.mockReturnValue(startedAt + RECENT_WORKSTREAM_SOCKET_RETENTION_MS);
    act(() => vi.advanceTimersByTime(RECENT_WORKSTREAM_SOCKET_RETENTION_MS + 60_000));
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
  });
});
