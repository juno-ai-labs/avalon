import { snapshotFrame } from './workstream-socket.test-fixtures';
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
  useOptionalWorkspaceSocket: () => null,
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

  keepHealthy(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    const id = String(this.url).split('/workstreams/')[1]!.split('/')[0]!;
    const snapshot = (): void => {
      this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(snapshotFrame({
        sequence: 1, workstream: {id},
      }))}));
    };
    this.send.mockImplementation((frame: string) => {
      if (frame === 'ping') queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: 'pong'})));
      else if (frame.includes('request_snapshot')) queueMicrotask(snapshot);
    });
    if (this.readyState === FakeWebSocket.CONNECTING) {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
      snapshot();
    }
  }

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
  /** The retired Channel control socket's ticket: a held Channel must never ask for one. */
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
  return <button {...warmup}>Warm channel</button>;
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
  it('opens only the feed for an automation beside the active Channel of the pool', async () => {
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

    // The pool's active Channel opened its feed; the automation opened a feed
    // of its own. Neither asked for a control ticket.
    expect(api.getSocketTicket).toHaveBeenCalledWith(
      automationId, '0', expect.anything(), 0, false, expect.anything(),
      WORKSTREAM_OPEN_TIMEOUT_BASE_MS,
    );
    expect(api.getSocketTicket.mock.calls.map(([id]) => id).sort()).toEqual([automationId, workstreamId].sort());
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
  });
});

describe('standalone conversation subscriptions', () => {
  it.each(['0', '00000000-0000-7000-8000-00000000c001'])('opens only the addressed feed for breakout %s', async (substreamId) => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const parentId = '00000000-0000-7000-8000-00000000b001';
    const Wrapper = createWrapper();
    function Conversation(): React.JSX.Element {
      const connection = useRetainedWorkstreamSocket(api, parentId, true, 'workstream', substreamId);
      return <div>{connection.state}</div>;
    }
    const view = render(<Wrapper><Conversation /></Wrapper>);
    await flushPromises();
    expect(api.getSocketTicket).toHaveBeenCalledWith(parentId, substreamId, expect.anything(), 0, false, expect.anything(), WORKSTREAM_OPEN_TIMEOUT_BASE_MS);
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    view.unmount();
    expect(FakeWebSocket.instances[0]?.close).toHaveBeenCalled();
  });
});

describe('WorkstreamSocketPool', () => {
  it('probes and bypasses backoff when returning to an admitted retained feed', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApi();
    const firstId = '00000000-0000-7000-8000-00000000064a';
    const secondId = '00000000-0000-7000-8000-00000000064b';
    const content = (id: string): React.JSX.Element => (
      <WorkstreamSocketPool activeWorkstreamId={id} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={id} />
      </WorkstreamSocketPool>
    );
    const view = render(content(firstId), { wrapper: createWrapper() });
    await act(async () => { await Promise.resolve(); });
    const first = FakeWebSocket.instances[0]!;
    act(() => first.keepHealthy());
    view.rerender(content(secondId));
    await act(async () => { await Promise.resolve(); });
    first.send.mockClear();
    view.rerender(content(firstId));
    await act(async () => { await Promise.resolve(); });
    expect(first.send).toHaveBeenCalledWith('ping');
    view.rerender(content(secondId));
    act(() => first.close(1006));
    const before = api.getSocketTicket.mock.calls.length;
    view.rerender(content(firstId));
    await act(async () => { await Promise.resolve(); });
    expect(api.getSocketTicket.mock.calls.length).toBe(before + 1);
  });

  it('opens and retains only the presence-free Main feed after a one-second hover', async () => {
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
    const target = view.getByRole('button', { name: 'Warm channel' });

    fireEvent.pointerEnter(target);
    await act(async () => vi.advanceTimersByTimeAsync(999));
    fireEvent.pointerLeave(target);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await flushPromises();
    act(() => FakeWebSocket.instances.forEach(socket => socket.keepHealthy()));
    expect(api.getSocketTicket).not.toHaveBeenCalled();
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();

    fireEvent.pointerEnter(target);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flushPromises();
    act(() => FakeWebSocket.instances.forEach(socket => socket.keepHealthy()));
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
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
    const warmedSockets = FakeWebSocket.instances.filter(
      (socket) => String(socket.url).includes(workstreamId),
    );
    expect(warmedSockets.map((socket) => String(socket.url))).toEqual([
      `wss://api.rally.test/workstreams/${workstreamId}/feed`,
    ]);

    fireEvent.pointerLeave(target);
    await act(async () => vi.advanceTimersByTimeAsync(RECENT_WORKSTREAM_SOCKET_RETENTION_MS - 1));
    expect(warmedSockets.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
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
    expect(feed.send.mock.calls.filter(([frame]) => String(frame).startsWith('{')).map(([frame]) => JSON.parse(String(frame)))).toEqual([
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
    expect(feed.send.mock.calls.filter(([frame]) => String(frame).startsWith('{')).map(([frame]) => JSON.parse(String(frame)))).toEqual([
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
    expect(feed.send.mock.calls.filter(([frame]) => String(frame).startsWith('{')).map(([frame]) => JSON.parse(String(frame)))).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
    ]);
    view.rerender(<Content allowed />);
    await flushPromises();
    expect(FakeWebSocket.instances).toEqual(pair);
    expect(pair.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
    expect(feed.send.mock.calls.filter(([frame]) => String(frame).startsWith('{')).map(([frame]) => JSON.parse(String(frame)))).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
      { type: 'mark_opened' },
    ]);
  });

  it('reuses the warmed feed after navigation succeeds', async () => {
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

    fireEvent.pointerEnter(view.getByRole('button', { name: 'Warm channel' }));
    act(() => vi.advanceTimersByTime(1_000));
    await flushPromises();
    const warmedSockets = [...FakeWebSocket.instances];
    if (warmedSockets.length !== 1) throw new Error('The hovered channel did not open exactly its feed.');
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
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
    if (!warmedFeed) throw new Error('The hovered channel opened no feed socket.');
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

    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
    expect(api.getSocketTicket).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.map((socket) => String(socket.url))).toEqual([
      `wss://api.rally.test/workstreams/${workstreamId}/feed`,
    ]);
    expect(FakeWebSocket.instances).toEqual(warmedSockets);
    expect(warmedSockets.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
    expect(warmedFeed.send.mock.calls.filter(([frame]) => String(frame).startsWith('{')).map(([frame]) => JSON.parse(String(frame)))).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
      { type: 'mark_opened' },
    ]);
    fireEvent.click(view.getByRole('button', { name: 'Read pool context' }));
    expect(onReadContext).toHaveBeenLastCalledWith({
      state: 'retained_pair',
      socketLeaseId: warmedContext.socketLeaseId,
    });
  });

  it('keeps at most one unopened feed warm', async () => {
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
    const targets = view.getAllByRole('button', { name: 'Warm channel' });
    const firstTarget = targets[0];
    const secondTarget = targets[1];
    if (!firstTarget || !secondTarget) throw new Error('Expected two hover targets.');

    fireEvent.pointerEnter(firstTarget);
    act(() => vi.advanceTimersByTime(1_000));
    await flushPromises();
    const firstPair = FakeWebSocket.instances.slice(0, 1);
    if (firstPair.length !== 1) throw new Error('The first hovered channel opened no feed.');

    fireEvent.pointerEnter(secondTarget);
    act(() => vi.advanceTimersByTime(1_000));
    await flushPromises();

    expect(api.getSocketTicket).toHaveBeenCalledTimes(2);
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
    expect(FakeWebSocket.instances.slice(1).every(
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
    if (!feedSocket) throw new Error('The active channel opened no feed socket.');

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
    if (!backgroundFeed) throw new Error('The background channel opened no feed socket.');

    act(() => {
      backgroundFeed.readyState = FakeWebSocket.OPEN;
      backgroundFeed.dispatchEvent(new Event('open'));
    });
    await flushPromises();

    expect(rendered).toHaveBeenCalledTimes(rendersBeforeBackgroundChange);
  });

  it('does not add a hover warm-up beyond the active feed', async () => {
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

    fireEvent.pointerEnter(view.getByRole('button', { name: 'Warm channel' }));
    act(() => vi.advanceTimersByTime(1_001));
    await flushPromises();

    expect(api.getSocketTicket).toHaveBeenCalledTimes(1);
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
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

    fireEvent.pointerEnter(view.getByRole('button', { name: 'Warm channel' }));
    act(() => vi.advanceTimersByTime(500));
    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={null} api={api} backgroundWorkstreamIds={[]} />,
    );
    act(() => vi.advanceTimersByTime(501));
    await flushPromises();

    expect(api.getSocketTicket).not.toHaveBeenCalled();
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
  });

  it('replaces a pending warm-up with the active feed', async () => {
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

    fireEvent.pointerEnter(view.getByRole('button', { name: 'Warm channel' }));
    act(() => vi.advanceTimersByTime(500));
    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={workstreamId} api={api} backgroundWorkstreamIds={[]}>
        <HoverWarmTarget workstreamId={workstreamId} />
      </WorkstreamSocketPool>,
    );
    act(() => vi.advanceTimersByTime(501));
    await flushPromises();

    expect(api.getSocketTicket).toHaveBeenCalledTimes(1);
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
  });

  it('keeps the route subtree mounted while the active channel changes', () => {
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
    act(() => FakeWebSocket.instances.forEach(socket => socket.keepHealthy()));

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled={false} workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    act(() => FakeWebSocket.instances.forEach(socket => socket.keepHealthy()));
    await act(async () => vi.advanceTimersByTimeAsync(RECENT_WORKSTREAM_SOCKET_RETENTION_MS));

    expect(api.getSocketTicket).toHaveBeenCalledTimes(2);
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances.map((socket) => String(socket.url))).toEqual([
      `wss://api.rally.test/workstreams/${firstWorkstreamId}/feed`,
      `wss://api.rally.test/workstreams/${secondWorkstreamId}/feed`,
    ]);
  });

  it('reuses the exact feed until retention expires', async () => {
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
    act(() => FakeWebSocket.instances.forEach(socket => socket.keepHealthy()));
    const firstPair = FakeWebSocket.instances.filter((socket) => String(socket.url).includes(firstWorkstreamId));
    expect(firstPair.map((socket) => String(socket.url))).toEqual([
      `wss://api.rally.test/workstreams/${firstWorkstreamId}/feed`,
    ]);

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    act(() => FakeWebSocket.instances.forEach(socket => socket.keepHealthy()));
    expect(api.getSocketTicket).toHaveBeenCalledTimes(2);
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(RECENT_WORKSTREAM_SOCKET_RETENTION_MS - 1));
    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={firstWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={firstWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    act(() => FakeWebSocket.instances.forEach(socket => socket.keepHealthy()));

    expect(api.getSocketTicket).toHaveBeenCalledTimes(2);
    expect(api.getWorkstreamControlSocketTicket).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances.filter((socket) => String(socket.url).includes(firstWorkstreamId)))
      .toEqual(firstPair);
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(RECENT_WORKSTREAM_SOCKET_RETENTION_MS));
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
  });

  it('keeps a background-running feed past the recent-view deadline', async () => {
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
    act(() => FakeWebSocket.instances.forEach(socket => socket.keepHealthy()));
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
    act(() => FakeWebSocket.instances.forEach(socket => socket.keepHealthy()));
    await act(async () => vi.advanceTimersByTimeAsync(RECENT_WORKSTREAM_SOCKET_RETENTION_MS));
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
    act(() => FakeWebSocket.instances.forEach(socket => socket.keepHealthy()));
    const firstPair = FakeWebSocket.instances.filter((socket) => String(socket.url).includes(firstWorkstreamId));
    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection api={api} enabled workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    act(() => FakeWebSocket.instances.forEach(socket => socket.keepHealthy()));

    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt - 60_000);
    await act(async () => vi.advanceTimersByTimeAsync(RECENT_WORKSTREAM_SOCKET_RETENTION_MS));
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);

    now.mockReturnValue(startedAt + RECENT_WORKSTREAM_SOCKET_RETENTION_MS);
    await act(async () => vi.advanceTimersByTimeAsync(RECENT_WORKSTREAM_SOCKET_RETENTION_MS + 60_000));
    expect(firstPair.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
  });
});
