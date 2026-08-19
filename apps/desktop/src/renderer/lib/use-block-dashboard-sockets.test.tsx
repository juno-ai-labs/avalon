import type { BlockDashboard } from '@avalon/contracts';
import { socketTicketProtocols } from '@avalon/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBlockDashboardSockets } from './use-block-dashboard-sockets';

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

  event(value: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
}

const workstreamId = '00000000-0000-7000-8000-000000000801';
const blockId = '00000000-0000-7000-8000-000000000802';
const versionId = '00000000-0000-7000-8000-000000000803';
const blockRunId = '00000000-0000-7000-8000-000000000804';
const messageId = '00000000-0000-7000-8000-000000000805';
const harnessRunId = '00000000-0000-7000-8000-000000000806';

function wrapper(queryClient: QueryClient): ({ children }: PropsWithChildren) => React.JSX.Element {
  return function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function run() {
  return {
    id: blockRunId,
    blockId,
    configurationVersionId: versionId,
    triggerSequence: 12,
    status: 'running' as const,
    markdown: null,
    error: null,
    createdAt: '2026-08-18T20:00:00.000Z',
    startedAt: '2026-08-18T20:00:01.000Z',
    completedAt: null,
  };
}

function checkpoint(roomSequence: number, text: string) {
  return {
    messageId,
    harnessRunId,
    turnId: 'turn-1',
    epoch: 0,
    streamSeq: roomSequence,
    seenTurnIds: ['turn-1'],
    text,
    turnStartOffset: 0,
    roomSequence,
    createdAt: '2026-08-18T20:00:01.000Z',
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe('useBlockDashboardSockets', () => {
  it('resumes from a full checkpoint and ignores stale updates without duplicating text', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    queryClient.setQueryData<BlockDashboard>(['block-dashboard', workstreamId], {
      versionId,
      versionNumber: 1,
      updatedAt: '2026-08-18T20:00:00.000Z',
      blocks: [{ id: blockId, prompt: 'Summarize', latestRun: null }],
    });
    const getBlockDashboardBlockSocketTicket = vi.fn(async () => ({
      url: `wss://api.avalon.test/socket/workstreams/${workstreamId}/block-dashboard/blocks/${blockId}`,
      ticket: 'block-ticket',
      protocols: socketTicketProtocols('block-ticket'),
    }));
    const api = { getBlockDashboardBlockSocketTicket };
    const rendered = renderHook(
      () => useBlockDashboardSockets(
        api,
        workstreamId,
        [blockId],
        true,
      ),
      { wrapper: wrapper(queryClient) },
    );
    await act(async () => Promise.resolve());
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    expect(first.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe' }));

    act(() => first.event({
      type: 'block_dashboard_block_snapshot',
      occurredAt: '2026-08-18T20:00:02.000Z',
      blockId,
      run: run(),
      streamCheckpoint: checkpoint(4, 'Hello'),
    }));
    expect(queryClient.getQueryData<BlockDashboard>(['block-dashboard', workstreamId]))
      .toMatchObject({ blocks: [{ latestRun: { markdown: 'Hello', status: 'running' } }] });

    act(() => first.event({
      type: 'block_dashboard_block_stream_checkpoint',
      occurredAt: '2026-08-18T20:00:03.000Z',
      blockId,
      blockRunId,
      streamCheckpoint: checkpoint(3, 'Hel'),
    }));
    expect(queryClient.getQueryData<BlockDashboard>(['block-dashboard', workstreamId]))
      .toMatchObject({ blocks: [{ latestRun: { markdown: 'Hello' } }] });

    act(() => first.event({
      type: 'block_dashboard_block_stream_checkpoint',
      occurredAt: '2026-08-18T20:00:04.000Z',
      blockId,
      blockRunId,
      streamCheckpoint: checkpoint(5, 'Hello world'),
    }));
    expect(queryClient.getQueryData<BlockDashboard>(['block-dashboard', workstreamId]))
      .toMatchObject({ blocks: [{ latestRun: { markdown: 'Hello world' } }] });
    expect(rendered.result.current[blockId]).toBe('connected');

    rendered.unmount();
  });

  it('backs off failed tickets and short-lived sockets, then stops after revocation', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    queryClient.setQueryData<BlockDashboard>(['block-dashboard', workstreamId], {
      versionId,
      versionNumber: 1,
      updatedAt: '2026-08-18T20:00:00.000Z',
      blocks: [{ id: blockId, prompt: 'Summarize', latestRun: null }],
    });
    const ticket = {
      url: `wss://api.avalon.test/socket/workstreams/${workstreamId}/block-dashboard/blocks/${blockId}`,
      ticket: 'block-ticket',
      protocols: socketTicketProtocols('block-ticket'),
    };
    const getBlockDashboardBlockSocketTicket = vi.fn()
      .mockRejectedValueOnce(new Error('ticket service unavailable'))
      .mockResolvedValue(ticket);
    const api = { getBlockDashboardBlockSocketTicket };
    const rendered = renderHook(
      () => useBlockDashboardSockets(
        api,
        workstreamId,
        [blockId],
        true,
      ),
      { wrapper: wrapper(queryClient) },
    );
    await act(async () => Promise.resolve());
    expect(rendered.result.current[blockId]).toBe('reconnecting');

    await act(async () => vi.advanceTimersByTimeAsync(750));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    await act(async () => Promise.resolve());
    act(() => first.event({
      type: 'block_dashboard_block_snapshot',
      occurredAt: '2026-08-18T20:00:02.000Z',
      blockId,
      run: run(),
      streamCheckpoint: null,
    }));
    expect(rendered.result.current[blockId]).toBe('connected');

    act(() => first.close());
    expect(rendered.result.current[blockId]).toBe('reconnecting');
    await act(async () => vi.advanceTimersByTimeAsync(1_499));
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    await act(async () => Promise.resolve());
    act(() => second.close(1008));
    expect(rendered.result.current[blockId]).toBe('revoked');
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    rendered.unmount();
  });

  it('pauses while offline, resumes online, and closes sockets for removed blocks', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    let online = false;
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
    const queryClient = new QueryClient();
    const getBlockDashboardBlockSocketTicket = vi.fn(async () => ({
      url: `wss://api.avalon.test/socket/workstreams/${workstreamId}/block-dashboard/blocks/${blockId}`,
      ticket: 'block-ticket',
      protocols: socketTicketProtocols('block-ticket'),
    }));
    const api = { getBlockDashboardBlockSocketTicket };
    const rendered = renderHook(
      ({ blocks }) => useBlockDashboardSockets(
        api,
        workstreamId,
        blocks,
        true,
      ),
      { initialProps: { blocks: [blockId] }, wrapper: wrapper(queryClient) },
    );
    await act(async () => Promise.resolve());
    expect(rendered.result.current[blockId]).toBe('offline');
    expect(getBlockDashboardBlockSocketTicket).not.toHaveBeenCalled();

    online = true;
    await act(async () => window.dispatchEvent(new Event('online')));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    rendered.rerender({ blocks: [] });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(rendered.result.current).toEqual({});
    rendered.unmount();
  });

  it('uses hibernation-safe ping/pong heartbeats and closes a silent connection', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const getBlockDashboardBlockSocketTicket = vi.fn(async () => ({
      url: `wss://api.avalon.test/socket/workstreams/${workstreamId}/block-dashboard/blocks/${blockId}`,
      ticket: 'block-ticket',
      protocols: socketTicketProtocols('block-ticket'),
    }));
    const api = { getBlockDashboardBlockSocketTicket };
    const rendered = renderHook(
      () => useBlockDashboardSockets(api, workstreamId, [blockId], true),
      { wrapper: wrapper(queryClient) },
    );
    await act(async () => Promise.resolve());
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    await act(async () => vi.advanceTimersByTimeAsync(50_000));
    expect(socket.send).toHaveBeenCalledWith('ping');
    act(() => socket.dispatchEvent(new MessageEvent('message', { data: 'pong' })));
    await act(async () => vi.advanceTimersByTimeAsync(50_000));
    expect(socket.send.mock.calls.filter(([message]) => message === 'ping')).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(rendered.result.current[blockId]).toBe('reconnecting');
    rendered.unmount();
  });

  it('logs the first malformed block frame without logging its payload', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getBlockDashboardBlockSocketTicket = vi.fn(async () => ({
      url: `wss://api.avalon.test/socket/workstreams/${workstreamId}/block-dashboard/blocks/${blockId}`,
      ticket: 'block-ticket',
      protocols: socketTicketProtocols('block-ticket'),
    }));
    const api = { getBlockDashboardBlockSocketTicket };
    const rendered = renderHook(
      () => useBlockDashboardSockets(
        api,
        workstreamId,
        [blockId],
        true,
      ),
      { wrapper: wrapper(new QueryClient()) },
    );
    await act(async () => Promise.resolve());
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.event({ privatePayload: 'do-not-log' }));
    act(() => socket.event({ another: 'malformed-frame' }));

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain('Ignored invalid BlockDashboardAgent socket event');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('do-not-log');
    rendered.unmount();
  });
});
