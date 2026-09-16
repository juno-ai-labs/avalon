import { ConversationAdmissionProvider } from './conversation-admission';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render } from '@testing-library/react';
import { useEffect, type PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSTREAM_OPEN_TIMEOUT_BASE_MS,
  type WorkstreamSocketApi,
  type WorkstreamSocketConnection,
} from './use-workstream-socket';
import {
  RECENT_WORKSTREAM_SOCKET_RETENTION_MS,
  WorkstreamSocketPool,
  retainedWorkstreamSocketIds,
  useRetainedWorkstreamSocket,
  useWorkstreamSocketHoverWarmup,
  useWorkstreamSocketOpenContext,
  type WorkstreamSocketOpenContext,
} from './workstream-socket-pool';

vi.mock('./workspace-socket', () => ({
  useWorkspaceSocket: () => ({
    state: 'connected',
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

function createWrapper(
  canonicalWorkstreamIds: readonly string[] = [],
): ({ children }: PropsWithChildren) => React.JSX.Element {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const workstreamId of canonicalWorkstreamIds) {
    queryClient.setQueryData(['workstream', workstreamId], { id: workstreamId });
    queryClient.setQueryData(['ordered-transcript', workstreamId], {});
  }
  return function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function socketApi(): WorkstreamSocketApi & {
  getSocketTicket: ReturnType<typeof vi.fn>;
  getWorkstreamControlSocketTicket: ReturnType<typeof vi.fn>;
} {
  return {
    viewerUserId: 'user-adam',
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
    messageMentionPayload: vi.fn(async () => []),
  };
}

function ActiveConnection({
  api,
  enabled,
  onRender,
  workstreamId,
}: {
  api: WorkstreamSocketApi;
  enabled: boolean;
  onRender?: () => void;
  workstreamId: string;
}): React.JSX.Element {
  onRender?.();
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

describe('useRetainedWorkstreamSocket for an automation parent', () => {
  it('opens only the feed: an automation has no WorkstreamDO control socket to warm', async () => {
    const api = socketApi();
    const automationId = '00000000-0000-7000-8000-00000000a001';
    const workstreamId = '00000000-0000-7000-8000-00000000b001';
    const Wrapper = createWrapper();
    function AutomationConnection(): React.JSX.Element {
      const connection = useRetainedWorkstreamSocket(api, automationId, true, 'automation', '0');
      return <div>{connection.state}</div>;
    }
    render(
      <Wrapper>
        <WorkstreamSocketPool activeWorkstreamId={workstreamId} api={api} backgroundWorkstreamIds={[]}>
          <AutomationConnection />
        </WorkstreamSocketPool>
      </Wrapper>,
    );
    await flushPromises();

    // The pool's active work stream opened its pair; the automation opened a
    // feed of its own and asked for no control ticket at all.
    expect(api.getSocketTicket).toHaveBeenCalledWith(
      automationId, '0', expect.anything(), 0, false, expect.anything(),
      WORKSTREAM_OPEN_TIMEOUT_BASE_MS,
    );
    expect(api.getWorkstreamControlSocketTicket.mock.calls.map(([id]) => id)).toEqual([workstreamId]);
  });
});

describe('WorkstreamSocketPool', () => {
  it('opens and retains the presence-free control/feed pair after a one-second hover', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const workstreamId = '00000000-0000-7000-8000-000000000630';
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={null} api={api} backgroundWorkstreamIds={[]}>
        <HoverWarmTarget workstreamId={workstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper([workstreamId]) },
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
    expect(api.getSocketTicket).toHaveBeenCalledTimes(1);
    expect(api.getSocketTicket).toHaveBeenCalledWith(
      workstreamId,
      '0',
      expect.any(String),
      0,
      true,
      expect.any(AbortSignal),
      WORKSTREAM_OPEN_TIMEOUT_BASE_MS,
    );
    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(1);
    const warmedSockets = FakeWebSocket.instances.filter(
      (socket) => String(socket.url).includes(workstreamId),
    );
    expect(warmedSockets.map((socket) => String(socket.url))).toEqual([
      `wss://api.rally.test/workstreams/${workstreamId}/control`,
      `wss://api.rally.test/workstreams/${workstreamId}/feed`,
    ]);

    fireEvent.pointerLeave(target);
    act(() => vi.advanceTimersByTime(RECENT_WORKSTREAM_SOCKET_RETENTION_MS - 1));
    expect(warmedSockets.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(warmedSockets.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
  });

  it('warms an opening route without marking it viewed until its feed mounts', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const workstreamId = '00000000-0000-7000-8000-000000000639';
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={workstreamId} api={api} backgroundWorkstreamIds={[]}>
        <div>Opening workspace</div>
      </WorkstreamSocketPool>, { wrapper: createWrapper([workstreamId]) },
    );
    await flushPromises();
    const pair = [...FakeWebSocket.instances];
    const feed = pair.find((socket) => String(socket.url).endsWith('/feed'))!;
    act(() => { feed.readyState = FakeWebSocket.OPEN; feed.dispatchEvent(new Event('open')); });
    await flushPromises();
    expect(feed.send.mock.calls.map(([frame]) => JSON.parse(String(frame)))).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
    ]);
    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={workstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={workstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    expect(FakeWebSocket.instances).toEqual(pair);
    expect(pair.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
    expect(feed.send.mock.calls.map(([frame]) => JSON.parse(String(frame)))).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
      { type: 'mark_opened' },
    ]);
  });

  it('keeps a mounted feed speculative until onboarding admits it without reconnecting', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const workstreamId = '00000000-0000-7000-8000-000000000639';
    let currentConnection: WorkstreamSocketConnection | undefined;
    function Feed(): React.JSX.Element {
      currentConnection = useRetainedWorkstreamSocket(api, workstreamId, true);
      return <div>{currentConnection.sendReady ? 'ready' : 'waiting'}</div>;
    }
    function Content({ allowed }: { allowed: boolean }): React.JSX.Element {
      return <ConversationAdmissionProvider allowed={allowed}><WorkstreamSocketPool activeWorkstreamId={workstreamId} api={api} backgroundWorkstreamIds={[]}>
        <Feed />
      </WorkstreamSocketPool></ConversationAdmissionProvider>;
    }
    const view = render(<Content allowed={false} />, { wrapper: createWrapper([workstreamId]) });
    await flushPromises();
    expect(currentConnection?.sendReady).toBe(false);
    await expect(currentConnection!.createMessage({ text: 'Wait for setup', clientId: '00000000-0000-7000-8000-000000000640', runMode: 'queue' })).rejects.toMatchObject({ code: 'workspace_setup_pending' });
    const pair = [...FakeWebSocket.instances];
    const feed = pair.find((socket) => String(socket.url).endsWith('/feed'))!;
    expect(api.getSocketTicket).toHaveBeenCalledWith(
      workstreamId, '0', expect.any(String), 0, true, expect.any(AbortSignal),
      WORKSTREAM_OPEN_TIMEOUT_BASE_MS,
    );
    act(() => { feed.readyState = FakeWebSocket.OPEN; feed.dispatchEvent(new Event('open')); });
    await flushPromises();
    expect(feed.send.mock.calls.map(([frame]) => JSON.parse(String(frame)))).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
    ]);
    view.rerender(<Content allowed />);
    await flushPromises();
    expect(FakeWebSocket.instances).toEqual(pair);
    expect(pair.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
    expect(feed.send.mock.calls.map(([frame]) => JSON.parse(String(frame)))).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
      { type: 'mark_opened' },
    ]);
  });

  it('reuses both warmed sockets after navigation succeeds', async () => {
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
      { wrapper: createWrapper([workstreamId]) },
    );

    fireEvent.click(view.getByRole('button', { name: 'Read pool context' }));
    expect(onReadContext).toHaveBeenLastCalledWith({ state: 'cold' });

    fireEvent.pointerEnter(view.getByRole('button', { name: 'Warm work stream' }));
    act(() => vi.advanceTimersByTime(1_000));
    await flushPromises();
    const warmedSockets = [...FakeWebSocket.instances];
    if (warmedSockets.length !== 2) throw new Error('The hovered work stream did not open its pair.');
    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(1);
    expect(api.getSocketTicket).toHaveBeenCalledTimes(1);
    expect(api.getSocketTicket).toHaveBeenCalledWith(
      workstreamId,
      '0',
      expect.any(String),
      0,
      true,
      expect.any(AbortSignal),
      WORKSTREAM_OPEN_TIMEOUT_BASE_MS,
    );
    const warmedFeed = warmedSockets.find((socket) => String(socket.url).endsWith('/feed'));
    if (!warmedFeed) throw new Error('The hovered work stream opened no feed socket.');
    act(() => {
      warmedFeed.readyState = FakeWebSocket.OPEN;
      warmedFeed.dispatchEvent(new Event('open'));
    });
    await flushPromises();
    fireEvent.click(view.getByRole('button', { name: 'Read pool context' }));
    const warmedContext = onReadContext.mock.lastCall?.[0] as WorkstreamSocketOpenContext;
    expect(warmedContext).toEqual({
      state: 'retained_pair',
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
    expect(FakeWebSocket.instances).toEqual(warmedSockets);
    expect(warmedSockets.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
    expect(warmedFeed.send.mock.calls.map(([frame]) => JSON.parse(String(frame)))).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
      { type: 'mark_opened' },
    ]);
    fireEvent.click(view.getByRole('button', { name: 'Read pool context' }));
    expect(onReadContext).toHaveBeenLastCalledWith({
      state: 'retained_pair',
      socketLeaseId: warmedContext.socketLeaseId,
    });
  });

  it('keeps at most one unopened socket pair warm', async () => {
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
      { wrapper: createWrapper([firstWorkstreamId, secondWorkstreamId]) },
    );
    const targets = view.getAllByRole('button', { name: 'Warm work stream' });
    const firstTarget = targets[0];
    const secondTarget = targets[1];
    if (!firstTarget || !secondTarget) throw new Error('Expected two hover targets.');

    fireEvent.pointerEnter(firstTarget);
    act(() => vi.advanceTimersByTime(1_000));
    await flushPromises();
    const firstPair = FakeWebSocket.instances.slice(0, 2);
    if (firstPair.length !== 2) throw new Error('The first hovered work stream opened no socket pair.');

    fireEvent.pointerEnter(secondTarget);
    act(() => vi.advanceTimersByTime(1_000));
    await flushPromises();

    expect(api.getSocketTicket).toHaveBeenCalledTimes(2);
    expect(api.getWorkstreamControlSocketTicket).toHaveBeenCalledTimes(2);
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
    expect(FakeWebSocket.instances.slice(2).every(
      (socket) => socket.close.mock.calls.length === 0,
    )).toBe(true);
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
      { wrapper: createWrapper([activeWorkstreamId]) },
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

  it('does not publish background connection churn through the active connection context', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const activeWorkstreamId = '00000000-0000-7000-8000-000000000646';
    const backgroundWorkstreamId = '00000000-0000-7000-8000-000000000647';
    const rendered = vi.fn();
    render(
      <WorkstreamSocketPool
        activeWorkstreamId={activeWorkstreamId}
        api={api}
        backgroundWorkstreamIds={[backgroundWorkstreamId]}
      >
        <ActiveConnection
          api={api}
          enabled
          onRender={rendered}
          workstreamId={activeWorkstreamId}
        />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper([activeWorkstreamId, backgroundWorkstreamId]) },
    );
    await flushPromises();
    const rendersBeforeBackgroundChange = rendered.mock.calls.length;
    const backgroundFeed = FakeWebSocket.instances.find((socket) =>
      String(socket.url).includes(backgroundWorkstreamId) && String(socket.url).endsWith('/feed'));
    if (!backgroundFeed) throw new Error('The background work stream opened no feed socket.');

    act(() => {
      backgroundFeed.readyState = FakeWebSocket.OPEN;
      backgroundFeed.dispatchEvent(new Event('open'));
    });
    await flushPromises();

    expect(rendered).toHaveBeenCalledTimes(rendersBeforeBackgroundChange);
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
      { wrapper: createWrapper([workstreamId]) },
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
      { wrapper: createWrapper([workstreamId]) },
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
      { wrapper: createWrapper([workstreamId]) },
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
      { wrapper: createWrapper([firstWorkstreamId, secondWorkstreamId]) },
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
      { wrapper: createWrapper([firstWorkstreamId, secondWorkstreamId]) },
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
      { wrapper: createWrapper([firstWorkstreamId, secondWorkstreamId]) },
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
      { wrapper: createWrapper([firstWorkstreamId, secondWorkstreamId]) },
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
