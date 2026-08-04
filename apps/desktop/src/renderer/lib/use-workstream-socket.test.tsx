import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AvalonApi } from './api';
import type { Message } from './types';
import {
  applyStreamingSocketEvent,
  insertMessage,
  mergeCanonicalTranscript,
  nextTranscriptSequence,
  SOCKET_STABLE_CONNECTION_MS,
  socketHeartbeatDelay,
  socketReconnectDelay,
  useWorkstreamSocket,
} from './use-workstream-socket';

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  send = vi.fn();

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  rawMessage(value: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: value }));
  }
}

function createWrapper(queryClient = new QueryClient()): ({ children }: PropsWithChildren) => React.JSX.Element {
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
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe('useWorkstreamSocket', () => {
  it('jitters heartbeat and exponential reconnect timing within bounded windows', () => {
    expect(socketHeartbeatDelay(() => 0)).toBe(45_000);
    expect(socketHeartbeatDelay(() => 0.999)).toBeGreaterThanOrEqual(54_000);
    expect(socketReconnectDelay(1, () => 0)).toBe(750);
    expect(socketReconnectDelay(1, () => 0.999)).toBeLessThanOrEqual(1_500);
    expect(socketReconnectDelay(99, () => 0.999)).toBeLessThanOrEqual(30_000);
  });

  it('reserves the next transcript anchor after an optimistic human turn', () => {
    const pendingHuman: Message = {
      id: 'pending-human',
      workstreamId: 'workstream-one',
      sequenceNumber: 8,
      authorType: 'human',
      messageType: 'text',
      text: 'One more question.',
      createdAt: '2026-07-31T19:20:00.000Z',
      deliveryState: 'sending',
      realtimeOrder: {
        anchorSequenceNumber: 8,
        eventSequence: Number.MAX_SAFE_INTEGER,
        placement: 'at_anchor',
      },
    };

    expect(nextTranscriptSequence([pendingHuman])).toBe(9);
  });

  it('reconciles the persisted realtime echo with its optimistic human message', () => {
    const clientMessageId = 'client-message-one';
    const pendingHuman: Message = {
      id: clientMessageId,
      clientMessageId,
      workstreamId: 'workstream-one',
      sequenceNumber: 8,
      authorType: 'human',
      messageType: 'text',
      text: 'One more question.',
      createdAt: '2026-07-31T19:20:00.000Z',
      deliveryState: 'sending',
    };
    const persistedHuman: Message = {
      ...pendingHuman,
      id: 'persisted-message-one',
      sequenceNumber: 9,
      createdAt: '2026-07-31T19:20:01.000Z',
      deliveryState: undefined,
    };

    expect(insertMessage([pendingHuman], persistedHuman)).toEqual([persistedHuman]);
    expect(insertMessage([pendingHuman, persistedHuman], persistedHuman)).toEqual([persistedHuman]);
    expect(mergeCanonicalTranscript([pendingHuman], [persistedHuman])).toEqual([persistedHuman]);
  });

  it('retains an unmatched optimistic human message during a canonical refresh', () => {
    const pendingHuman: Message = {
      id: 'client-message-two',
      clientMessageId: 'client-message-two',
      workstreamId: 'workstream-one',
      sequenceNumber: 10,
      authorType: 'human',
      messageType: 'text',
      text: 'Still being sent.',
      createdAt: '2026-07-31T19:20:02.000Z',
      deliveryState: 'sending',
    };
    const canonicalHuman: Message = {
      id: 'persisted-message-one',
      clientMessageId: 'client-message-one',
      workstreamId: 'workstream-one',
      sequenceNumber: 9,
      authorType: 'human',
      messageType: 'text',
      text: 'Already sent.',
      createdAt: '2026-07-31T19:20:01.000Z',
    };

    expect(mergeCanonicalTranscript([pendingHuman], [canonicalHuman])).toEqual([
      canonicalHuman,
      pendingHuman,
    ]);
  });

  it('deduplicates replayed chunks and replaces only the retried Bind turn on reset', () => {
    const workstreamId = '00000000-0000-7000-8000-000000000021';
    const messageId = '00000000-0000-7000-8000-000000000051';
    const harnessRunId = '00000000-0000-7000-8000-000000000052';
    const cursors = new Map();
    let transcript = applyStreamingSocketEvent([], {
      type: 'stream_started',
      sequence: 10,
      occurredAt: '2026-07-31T19:21:00.000Z',
      messageId,
      harnessRunId,
      turnId: 'turn-one',
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 11,
      occurredAt: '2026-07-31T19:21:01.000Z',
      messageId,
      turnId: 'turn-one',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'Hel',
    }, workstreamId, cursors);
    // A replay can receive a fresh room sequence while repeating an already
    // applied stream sequence. It must not concatenate the chunk twice.
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 12,
      occurredAt: '2026-07-31T19:21:01.000Z',
      messageId,
      turnId: 'turn-one',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'Hel',
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 13,
      occurredAt: '2026-07-31T19:21:02.000Z',
      messageId,
      turnId: 'turn-one',
      epoch: 0,
      streamSeq: 2,
      reset: false,
      delta: 'lo',
    }, workstreamId, cursors);
    expect(transcript.find((message) => message.id === messageId)?.text).toBe('Hello');

    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_started',
      sequence: 14,
      occurredAt: '2026-07-31T19:21:03.000Z',
      messageId,
      harnessRunId,
      turnId: 'turn-two',
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 15,
      occurredAt: '2026-07-31T19:21:04.000Z',
      messageId,
      turnId: 'turn-two',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: ' discard this',
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 16,
      occurredAt: '2026-07-31T19:21:05.000Z',
      messageId,
      turnId: 'turn-two',
      epoch: 1,
      streamSeq: 2,
      reset: true,
      delta: '',
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 17,
      occurredAt: '2026-07-31T19:21:06.000Z',
      messageId,
      turnId: 'turn-two',
      epoch: 1,
      streamSeq: 3,
      reset: false,
      delta: ' world',
    }, workstreamId, cursors);
    // A delayed frame from the abandoned route cannot overwrite the fallback.
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 18,
      occurredAt: '2026-07-31T19:21:07.000Z',
      messageId,
      turnId: 'turn-two',
      epoch: 0,
      streamSeq: 99,
      reset: false,
      delta: ' stale',
    }, workstreamId, cursors);
    expect(transcript.find((message) => message.id === messageId)?.text).toBe('Hello world');
  });

  it('appends Bind post-tool turns and keeps tool order across REST refreshes', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000021';
    const workspaceId = '00000000-0000-7000-8000-000000000002';
    const harnessRunId = '00000000-0000-7000-8000-000000000051';
    const assistantMessageId = harnessRunId;
    const toolOneId = '00000000-0000-7000-8000-000000000052';
    const toolTwoId = '00000000-0000-7000-8000-000000000053';
    const humanMessage: Message = {
      id: '00000000-0000-7000-8000-000000000032',
      workstreamId,
      sequenceNumber: 17,
      authorType: 'human',
      author: { id: 'user-one', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles' },
      messageType: 'text',
      text: 'Investigate this.',
      createdAt: '2026-07-31T19:20:00.000Z',
    };
    queryClient.setQueryData(['messages', workstreamId], [humanMessage]);
    const getSocketTicket = vi.fn(async () => ({
      url: `wss://api.avalon.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
    }));
    const api = { getSocketTicket } as unknown as AvalonApi;
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    act(() => FakeWebSocket.instances[0]?.open());
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'stream_started',
      sequence: 204,
      occurredAt: '2026-07-31T19:21:00.000Z',
      messageId: assistantMessageId,
      harnessRunId,
      turnId: 'turn-one',
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'stream_delta',
      sequence: 205,
      occurredAt: '2026-07-31T19:21:00.500Z',
      messageId: assistantMessageId,
      turnId: 'turn-one',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'I will check. ',
    }));
    const invocation = (id: string, toolCallId: string, toolName: string, status: 'started' | 'completed') => ({
      id,
      harnessRunId,
      toolCallId,
      toolName,
      connectionId: null,
      status,
      inputSummary: `Input for ${toolName}`,
      outputSummary: status === 'completed' ? `Result from ${toolName}` : null,
      startedAt: '2026-07-31T19:21:01.000Z',
      completedAt: status === 'completed' ? '2026-07-31T19:21:05.000Z' : null,
      error: null,
    });
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'tool_started',
      sequence: 206,
      occurredAt: '2026-07-31T19:21:01.000Z',
      invocation: invocation(toolOneId, 'tool-one', 'First tool', 'started'),
    }));
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'tool_started',
      sequence: 207,
      occurredAt: '2026-07-31T19:21:02.000Z',
      invocation: invocation(toolTwoId, 'tool-two', 'Second tool', 'started'),
    }));
    // The first tool happens to finish last. Its completion must update it in
    // place rather than moving it below the second tool.
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'tool_completed',
      sequence: 208,
      occurredAt: '2026-07-31T19:21:05.000Z',
      invocation: invocation(toolTwoId, 'tool-two', 'Second tool', 'completed'),
    }));
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'tool_completed',
      sequence: 209,
      occurredAt: '2026-07-31T19:21:06.000Z',
      invocation: invocation(toolOneId, 'tool-one', 'First tool', 'completed'),
    }));
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'stream_started',
      sequence: 210,
      occurredAt: '2026-07-31T19:21:06.500Z',
      messageId: assistantMessageId,
      harnessRunId,
      turnId: 'turn-two',
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'stream_delta',
      sequence: 211,
      occurredAt: '2026-07-31T19:21:06.750Z',
      messageId: assistantMessageId,
      turnId: 'turn-two',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'Here is the result.',
    }));

    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])
      ?.find((message) => message.id === assistantMessageId)?.text).toBe('I will check. Here is the result.');

    const assistantMessage: Message = {
      id: assistantMessageId,
      workstreamId,
      sequenceNumber: 20,
      authorType: 'agent',
      messageType: 'text',
      text: 'I will check. Here is the result.',
      createdAt: '2026-07-31T19:21:07.000Z',
    };
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'stream_completed',
      sequence: 212,
      occurredAt: '2026-07-31T19:21:07.000Z',
      message: {
        id: assistantMessage.id,
        clientMessageId: null,
        workspaceId,
        workstreamId,
        author: { type: 'agent' },
        messageType: 'text',
        textContent: assistantMessage.text,
        structuredContent: null,
        mentions: [],
        sequenceNumber: assistantMessage.sequenceNumber,
        createdAt: assistantMessage.createdAt,
        editedAt: null,
      },
    }));
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'stream_delta',
      sequence: 213,
      occurredAt: '2026-07-31T19:21:08.000Z',
      messageId: assistantMessageId,
      turnId: 'turn-two',
      epoch: 0,
      streamSeq: 2,
      reset: false,
      delta: 'This late chunk must be ignored.',
    }));

    const live = queryClient.getQueryData<Message[]>(['messages', workstreamId]) ?? [];
    expect(live.map((message) => message.id)).toEqual([
      humanMessage.id,
      `tool-${toolOneId}`,
      `tool-${toolTwoId}`,
      assistantMessage.id,
    ]);

    const refreshedBeforePersistence = mergeCanonicalTranscript(live, [humanMessage, assistantMessage]);
    expect(refreshedBeforePersistence.map((message) => message.id)).toEqual([
      humanMessage.id,
      `tool-${toolOneId}`,
      `tool-${toolTwoId}`,
      assistantMessage.id,
    ]);

    const canonicalToolMessages = live
      .filter((message) => message.messageType === 'tool_event')
      .map((message, index): Message => ({
        ...message,
        id: message.toolEvent!.id,
        sequenceNumber: 18 + index,
        realtimeOrder: undefined,
      }));
    const canonical = [humanMessage, ...canonicalToolMessages, assistantMessage];

    // A cold load needs no realtime history to reconstruct the turn.
    expect(canonical.map((message) => message.id)).toEqual([
      humanMessage.id,
      toolOneId,
      toolTwoId,
      assistantMessage.id,
    ]);

    // A REST refresh that lands while realtime rows are still cached replaces
    // them by invocation identity instead of displaying both copies.
    const reconciled = mergeCanonicalTranscript(live, canonical);
    expect(reconciled.map((message) => message.id)).toEqual([
      humanMessage.id,
      toolOneId,
      toolTwoId,
      assistantMessage.id,
    ]);
    expect(reconciled.filter((message) => message.messageType === 'tool_event')).toHaveLength(2);
    expect(reconciled.find((message) => message.id === assistantMessage.id)?.text).toBe('I will check. Here is the result.');
  });

  it('retains per-epoch stream cursors across a socket reconnect', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000061';
    const messageId = '00000000-0000-7000-8000-000000000062';
    const harnessRunId = '00000000-0000-7000-8000-000000000063';
    const api = {
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.avalon.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
      })),
    } as unknown as AvalonApi;
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.message({
      type: 'stream_started',
      sequence: 1,
      occurredAt: '2026-07-31T19:21:00.000Z',
      messageId,
      harnessRunId,
      turnId: 'turn-reconnect',
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => first.message({
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-07-31T19:21:01.000Z',
      messageId,
      turnId: 'turn-reconnect',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'One',
    }));
    act(() => first.close());
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    expect(second.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 2 }));

    act(() => second.message({
      type: 'stream_delta',
      sequence: 3,
      occurredAt: '2026-07-31T19:21:02.000Z',
      messageId,
      turnId: 'turn-reconnect',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'One',
    }));
    act(() => second.message({
      type: 'stream_delta',
      sequence: 4,
      occurredAt: '2026-07-31T19:21:03.000Z',
      messageId,
      turnId: 'turn-reconnect',
      epoch: 0,
      streamSeq: 2,
      reset: false,
      delta: ' two',
    }));
    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])?.[0]?.text).toBe('One two');
  });

  it('resets the replay sequence when the selected workstream changes', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const getSocketTicket = vi.fn(async (workstreamId: string) => ({
      url: `wss://api.avalon.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
    }));
    const api = { getSocketTicket } as unknown as AvalonApi;
    const { rerender } = renderHook(
      ({ workstreamId }) => useWorkstreamSocket(api, workstreamId, true),
      { initialProps: { workstreamId: 'workstream-one' }, wrapper: createWrapper() },
    );

    await flushPromises();
    act(() => FakeWebSocket.instances[0]?.open());
    expect(FakeWebSocket.instances[0]?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 0 }));

    act(() => FakeWebSocket.instances[0]?.message({
      type: 'harness_status_changed',
      sequence: 9,
      occurredAt: '2026-07-31T20:00:00.000Z',
      status: 'running',
    }));
    rerender({ workstreamId: 'workstream-two' });
    await flushPromises();
    act(() => FakeWebSocket.instances[1]?.open());

    expect(FakeWebSocket.instances[1]?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 0 }));
  });

  it('keeps retrying ticket failures beyond the old four-attempt cutoff', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const getSocketTicket = vi.fn(async () => {
      throw new Error('offline');
    });
    const api = { getSocketTicket } as unknown as AvalonApi;
    renderHook(() => useWorkstreamSocket(api, 'workstream-one', true), { wrapper: createWrapper() });

    await flushPromises();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
    }

    expect(getSocketTicket.mock.calls.length).toBeGreaterThan(4);
  });

  it('keeps exponential backoff across sockets that open and then flap', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const getSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/workstreams/workstream-one',
      ticket: 'socket-ticket',
    }));
    const api = { getSocketTicket } as unknown as AvalonApi;
    renderHook(() => useWorkstreamSocket(api, 'workstream-one', true), { wrapper: createWrapper() });

    await flushPromises();
    act(() => {
      FakeWebSocket.instances[0]?.open();
      FakeWebSocket.instances[0]?.close();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(749); });
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(FakeWebSocket.instances).toHaveLength(2);

    act(() => {
      FakeWebSocket.instances[1]?.open();
      FakeWebSocket.instances[1]?.close();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_499); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(FakeWebSocket.instances).toHaveLength(3);

    act(() => FakeWebSocket.instances[2]?.open());
    await act(async () => { await vi.advanceTimersByTimeAsync(SOCKET_STABLE_CONNECTION_MS); });
    act(() => FakeWebSocket.instances[2]?.close());
    await act(async () => { await vi.advanceTimersByTimeAsync(749); });
    expect(FakeWebSocket.instances).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('reconnects immediately when the browser comes back online', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    let online = false;
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
    const getSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/workstreams/workstream-one',
      ticket: 'socket-ticket',
    }));
    const api = { getSocketTicket } as unknown as AvalonApi;
    const { result } = renderHook(() => useWorkstreamSocket(api, 'workstream-one', true), { wrapper: createWrapper() });

    await flushPromises();
    expect(result.current).toBe('unavailable');
    expect(getSocketTicket).not.toHaveBeenCalled();

    online = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
    });

    expect(getSocketTicket).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('uses raw ping/pong keepalives without treating pong as an application event', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const getSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/workstreams/workstream-one',
      ticket: 'socket-ticket',
    }));
    const api = { getSocketTicket } as unknown as AvalonApi;
    renderHook(() => useWorkstreamSocket(api, 'workstream-one', true), { wrapper: createWrapper() });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(socket.send).toHaveBeenCalledWith('ping');
    act(() => socket.rawMessage('pong'));
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(socket.send.mock.calls.filter(([frame]) => frame === 'ping')).toHaveLength(2);
  });

  it('retains its replay cursor until direct canonical recovery succeeds', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    queryClient.setQueryData(['workstream', 'workstream-one'], { id: 'workstream-one', title: 'Stale' });
    queryClient.setQueryData(['messages', 'workstream-one'], []);
    queryClient.setQueryData(['workstreams'], [{ id: 'workstream-one', title: 'Stale' }]);
    const getSocketTicket = vi.fn(async () => ({
      url: 'wss://api.avalon.test/workstreams/workstream-one',
      ticket: 'socket-ticket',
    }));
    const canonicalWorkstream = { id: 'workstream-one', title: 'Canonical' };
    const canonicalWorkstreams = [{ id: 'workstream-one', title: 'Canonical' }];
    const getWorkstream = vi.fn(async () => canonicalWorkstream);
    const getMessages = vi.fn()
      .mockRejectedValueOnce(new Error('transient D1 failure'))
      .mockResolvedValueOnce([]);
    const getWorkstreams = vi.fn(async () => canonicalWorkstreams);
    const api = {
      getSocketTicket,
      getWorkstream,
      getMessages,
      getWorkstreams,
    } as unknown as AvalonApi;
    renderHook(() => useWorkstreamSocket(api, 'workstream-one', true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    act(() => FakeWebSocket.instances[0]?.open());
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'resync_required',
      sequence: 14,
      latestSequence: 14,
      occurredAt: '2026-07-31T20:00:00.000Z',
      reason: 'history_unavailable',
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(getMessages).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(queryClient.getQueryData<{ title: string }>(['workstream', 'workstream-one'])?.title).toBe('Stale');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1]?.open());
    expect(FakeWebSocket.instances[1]?.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', afterSequence: 14 }),
    );
    expect(queryClient.getQueryData<{ title: string }>(['workstream', 'workstream-one'])?.title).toBe('Canonical');
    expect(queryClient.getQueryData(['workstreams'])).toEqual(canonicalWorkstreams);
  });
});
