import { emptyTranscriptSnapshot, snapshotFrame } from './workstream-socket.test-fixtures';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import {
  ClientSocketEventSchema,
  type ClientSocketEvent,
  type PendingTranscriptInput,
  type WorkstreamTranscriptSnapshot,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
} from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopRealtimeSocketHandshakePhase } from '../../common/realtime-socket';
import type { Message, WorkstreamBoot, WorkstreamDetail, WorkstreamSummary } from './types';
import { setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import {
  applyActiveStreamCheckpoints,
  applyStreamingOverlayEvent,
  applyStreamingSocketEvent,
  insertMessage,
  nextTranscriptSequence,
  SOCKET_STABLE_CONNECTION_MS,
  socketHeartbeatDelay,
  socketReconnectDelay,
  substreamInitialContextQueryKey,
  useWorkstreamSocket,
  WORKSTREAM_OPEN_TIMEOUT_ATTEMPTS,
  WORKSTREAM_OPEN_TIMEOUT_BASE_MS,
  workstreamOpenTimeoutMs,
  type WorkstreamSocketApi,
} from './use-workstream-socket';
import {
  RECENT_WORKSTREAM_SOCKET_RETENTION_MS,
  WorkstreamSocketPool,
  useRetainedWorkstreamSocket,
} from './workstream-socket-pool';
import { WorkstreamSocketResumeProvider } from './workstream-socket-resume';
import { conversationCacheKey, conversationSlice } from './conversation-cache';
import { clearAllLocalCache } from './local-cache';
import { LOCAL_CACHE_WRITE_COALESCE_MS } from './local-cache-mirror';
import { LocalCacheScopeProvider } from './local-cache-scope';
import {
  orderedTranscriptMessages,
  transcriptGaps,
  transcriptOverlaysQueryKey,
  type TranscriptOverlay,
} from './transcript';
import { requestSocketTicket } from './socket-ticket-request';

function overlayMessages(queryClient: QueryClient, workstreamId: string): Message[] {
  return (queryClient.getQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(workstreamId)) ?? [])
    .map((overlay) => overlay.message);
}


import type * as TelemetryModule from './telemetry';
import {
  cancelWorkstreamFeedOpen,
  markWorkstreamFeedOpenStarted,
  workstreamFeedSourceQueryKey,
  workstreamSocketSnapshotGenerationQueryKey,
} from './telemetry';

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

  /** `code` defaults to a normal closure; the hook only distinguishes one. */
  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  rawMessage(value: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: value }));
  }

  handshakePhase(
    phase: DesktopRealtimeSocketHandshakePhase,
    durationMs: number,
  ): void {
    this.dispatchEvent(Object.assign(new Event('handshakephase'), {
      phase,
      durationMs,
      routeIndex: 0,
      proxied: false,
    }));
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

/**
 * Deterministic animation frames for the paced reveal. jsdom backs
 * `requestAnimationFrame` with a real 16ms timer, which several tests here
 * cannot use — they run under fake timers, or would wait through hundreds of
 * frames of paced reveal to see a text assertion. The stub queues callbacks,
 * and `flush` pumps them until the reveal loop stops re-arming, i.e. until
 * every streaming message shows everything it has received.
 */
function stubAnimationFrames(): { flush: () => Promise<void>; step: (now: number) => Promise<void> } {
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  let frameTime = performance.now();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    nextId += 1;
    queue.set(nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    queue.delete(id);
  });
  return {
    async step(now: number): Promise<void> {
      const pending = [...queue.values()];
      queue.clear();
      frameTime = now;
      await act(async () => {
        for (const callback of pending) callback(now);
      });
    },
    async flush(): Promise<void> {
      for (let round = 0; round < 100_000 && queue.size > 0; round += 1) {
        const pending = [...queue.values()];
        queue.clear();
        await act(async () => {
          frameTime = Math.max(frameTime + 1000 / 60, performance.now());
          for (const callback of pending) callback(frameTime);
        });
      }
    },
  };
}

function queryDetail(queryClient: QueryClient, workstreamId: string): WorkstreamDetail | undefined {
  return queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId]);
}

function socketApiWith(overrides: Partial<WorkstreamSocketApi>): WorkstreamSocketApi {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected socket API call.');
  };
  return {
    viewerUserId: null,
    getSocketTicket: vi.fn(unexpected),
    messageMentionPayload: vi.fn(async () => []),
    ...overrides,
  } satisfies WorkstreamSocketApi;
}

function workstreamSummary(overrides: Partial<WorkstreamSummary> = {}): WorkstreamSummary {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    title: 'Canonical channel',
    titleStatus: 'settled',
    harnessStatus: 'completed',
    scope: 'workspace',
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    nextPendingWakeup: null,
    pinPosition: null,
    participantUserIds: [],
    participantExtraCount: 0,
    spaceIds: [],
    lastActivityAt: '2026-07-31T20:00:00.000Z',
    ...overrides,
  };
}

function workstreamDetail(overrides: Partial<WorkstreamDetail> = {}): WorkstreamDetail {
  return {
    ...workstreamSummary(overrides),
    createdAt: '2026-07-31T19:00:00.000Z',
    participants: [],
    viewers: [],
    resources: [],
    connections: [],
    backgroundTasks: [],
    ...overrides,
  };
}


function transcriptTurn(sequence: number, text: string) {
  return {
    transcriptSequence: sequence,
    turnId: `turn-${sequence}`,
    entryKind: 'conversation' as const,
    actor: 'assistant' as const,
    authorUserId: null,
    authorSnapshot: null,
    attentionOrdinal: null,
    createdAtUtc: '2026-07-31T19:00:00.000Z',
    revision: 1,
    blocks: [{
      type: 'text' as const,
      blockId: `turn-${sequence}:text:0`,
      blockIndex: 0,
      text,
      streaming: false,
    }],
    activityId: null,
  };
}

function pendingInput(sequence: number, text: string): PendingTranscriptInput {
  const inputId = `pending-${sequence}`;
  return {
    inputId,
    futureTurnId: inputId,
    inputSequence: sequence,
    deliveryMode: 'queue',
    afterTranscriptSequence: 0,
    actor: 'human',
    authorUserId: 'user-1',
    authorSnapshot: { userId: 'user-1', displayName: 'Member', avatarUrl: null },
    clientMessageId: `client-pending-${sequence}`,
    externalActor: null,
    block: {
      type: 'text', blockId: `${inputId}:text:0`, blockIndex: 0, text, streaming: false,
    },
    admittedAtUtc: '2026-07-31T19:00:00.000Z',
  };
}

/**
 * A work-stream detail in the shape the room puts on the wire, which is not the
 * shape the renderer holds. The hook validates every frame against the shared
 * contract before applying it, so a snapshot built from the renderer's own
 * `WorkstreamDetail` is rejected as malformed and silently ignored — a test
 * written that way passes its assertions against the state it set up itself.
 */

function legacySuggestedResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-7000-8000-000000000096',
    slug: null,
    workspaceId: '00000000-0000-7000-8000-000000000001',
    connectionId: null,
    resourceType: 'document',
    provider: 'google_drive',
    providerResourceId: 'drive-legacy',
    title: 'Previously accepted context',
    mimeType: 'application/pdf',
    canonicalUrl: null,
    refreshSupported: false,
    watchEnabled: false,
    watchStatus: 'unsupported',
    lastHydratedAt: null,
    createdAt: '2026-07-31T19:00:00.000Z',
    updatedAt: '2026-07-31T19:00:00.000Z',
    contentAvailable: false,
    sizeBytes: 0,
    currentVersion: 1,
    relationshipType: 'suggested_activity',
    direction: 'source',
    ...overrides,
  };
}


/** The frames a socket was asked to send, in order, excluding raw keepalives. */
function sentFrames(socket: FakeWebSocket): ClientSocketEvent[] {
  return socket.send.mock.calls
    .map(([frame]) => frame)
    .filter((frame): frame is string => typeof frame === 'string' && frame.startsWith('{'))
    .map((frame) => ClientSocketEventSchema.parse(JSON.parse(frame)));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  reportTelemetryProductIntent.mockClear();
  FakeWebSocket.instances = [];
});

describe('useWorkstreamSocket', () => {
  it('confirms network recovery only after the ticket yields a usable live snapshot', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000731';
    const ticket = { url: `wss://api.rally.test/workstreams/${workstreamId}`, ticket: 'feed-ticket',
      protocols: socketTicketProtocols('feed-ticket') };
    const confirmSocketTicket = vi.fn();
    const api = socketApiWith({ getSocketTicket: vi.fn(async () => ticket), confirmSocketTicket });
    const owner = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(confirmSocketTicket).not.toHaveBeenCalled();
    act(() => socket.message({ type: 'snapshot', malformed: true }));
    expect(confirmSocketTicket).not.toHaveBeenCalled();
    act(() => socket.message(snapshotFrame({ sequence: 1, workstream: { id: workstreamId, title: 'Live recovery' } })));
    expect(queryClient.getQueryData(['workstream', workstreamId])).toMatchObject({ title: 'Live recovery' });
    expect(confirmSocketTicket).toHaveBeenCalledExactlyOnceWith(ticket);
    owner.unmount();
    queryClient.clear();
  });

  it('keeps the canonical feed resident without a screen while the socket owner is retained', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000731';
    const api = socketApiWith({ getSocketTicket: vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`, ticket: 'feed-ticket',
      protocols: socketTicketProtocols('feed-ticket'),
    })) });
    const owner = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    socket.send.mockImplementation((frame: string) => {
      if (frame === 'ping') queueMicrotask(() => socket.rawMessage('pong'));
    });
    act(() => {
      socket.open();
      socket.message(snapshotFrame({ sequence: 1, workstream: { id: workstreamId, title: 'Retained feed' } }));
    });
    const keys = [
      ['workstream', workstreamId], ['ordered-transcript', workstreamId],
      substreamInitialContextQueryKey(workstreamId, '0'), transcriptOverlaysQueryKey(workstreamId),
      workstreamFeedSourceQueryKey(workstreamId), workstreamSocketSnapshotGenerationQueryKey(workstreamId),
    ];
    const snapshot = keys.map((key) => queryClient.getQueryData(key));
    expect(snapshot.every((value) => value !== undefined)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(keys.map((key) => queryClient.getQueryData(key))).toEqual(snapshot);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(owner.result.current.state).toBe('connected');
    owner.unmount();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(keys.map((key) => queryClient.getQueryData(key))).toEqual(keys.map(() => undefined));
    queryClient.clear();
  });

  it('keeps the connection object stable when none of its fields changed', () => {
    const api = socketApiWith({});
    const { result, rerender } = renderHook(
      () => useWorkstreamSocket(api, '00000000-0000-7000-8000-000000000620', false),
      { wrapper: createWrapper() },
    );
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });

  it('times out opening after 10, 20, and 40 seconds, then waits for an explicit retry', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-01T12:00:00.000Z') });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-00000000063a';
    const getSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(),
    });

    await flushPromises();
    const pendingCommand = expect(result.current.stopHarness()).rejects.toMatchObject({
      code: 'workstream_socket_open_timeout',
    });
    expect(WORKSTREAM_OPEN_TIMEOUT_ATTEMPTS).toBe(3);
    expect([
      workstreamOpenTimeoutMs(0),
      workstreamOpenTimeoutMs(1),
      workstreamOpenTimeoutMs(2),
      workstreamOpenTimeoutMs(3),
    ]).toEqual([
      WORKSTREAM_OPEN_TIMEOUT_BASE_MS,
      WORKSTREAM_OPEN_TIMEOUT_BASE_MS * 2,
      WORKSTREAM_OPEN_TIMEOUT_BASE_MS * 4,
      WORKSTREAM_OPEN_TIMEOUT_BASE_MS * 4,
    ]);
    expect(getSocketTicket).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(result.current.state).toBe('connecting');
    expect(getSocketTicket).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(result.current.state).toBe('reconnecting');
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(getSocketTicket).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(2);

    await act(async () => vi.advanceTimersByTimeAsync(19_999));
    expect(getSocketTicket).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe('reconnecting');
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(getSocketTicket).toHaveBeenCalledTimes(3);
    expect(FakeWebSocket.instances).toHaveLength(3);

    await act(async () => vi.advanceTimersByTimeAsync(39_999));
    expect(result.current.openingError).toBeUndefined();
    expect(getSocketTicket).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(result.current.state).toBe('unavailable');
    expect(result.current.openingError).toBe('The live connection timed out after 3 attempts.');
    expect(result.current.sendReady).toBe(false);
    await pendingCommand;
    await expect(result.current.stopHarness()).rejects.toMatchObject({
      code: 'workstream_socket_open_timeout',
    });
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(getSocketTicket).toHaveBeenCalledTimes(3);

    act(() => result.current.retryOpening());
    await flushPromises();
    expect(result.current.openingError).toBeUndefined();
    expect(getSocketTicket).toHaveBeenCalledTimes(4);
  });

  it('aborts a timed-out ticket request and fences its late response', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-00000000073a';
    const ticket = {
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    };
    let resolveFirstTicket: ((value: typeof ticket) => void) | undefined;
    let requestCount = 0;
    const getSocketTicket = vi.fn((
      ...args: Parameters<WorkstreamSocketApi['getSocketTicket']>
    ) => {
      void args;
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise<typeof ticket>((resolve) => {
          resolveFirstTicket = resolve;
        });
      }
      return Promise.resolve(ticket);
    });
    const api = socketApiWith({ getSocketTicket });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(),
    });

    await flushPromises();
    const firstSignal = getSocketTicket.mock.calls[0]?.[5] as AbortSignal | undefined;
    expect(firstSignal?.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(firstSignal?.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.state).toBe('reconnecting');
    expect(socketTelemetry()).toContainEqual({
      kind: 'realtime_socket_state',
      socket: 'substream_feed',
      state: 'retrying',
      cause: 'ticket_timeout',
      attempts: 'zero',
    });

    await act(async () => {
      resolveFirstTicket?.(ticket);
      await Promise.resolve();
    });
    expect(FakeWebSocket.instances).toHaveLength(0);

    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(getSocketTicket).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('keeps the escalating cold-open budget authoritative for slow tickets', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-00000000073b';
    const ticket = {
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    };
    const getSocketTicket = vi.fn((
      ...args: Parameters<WorkstreamSocketApi['getSocketTicket']>
    ) => requestSocketTicket((signal) => new Promise<typeof ticket>((resolve, reject) => {
      const timer = window.setTimeout(() => resolve(ticket), 15_000);
      signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    }), {
      ownerSignal: args[5],
      timeoutMs: args[6],
    }));
    const api = socketApiWith({ getSocketTicket });
    const { result } = renderHook(
      () => useWorkstreamSocket(api, workstreamId, true),
      { wrapper: createWrapper() },
    );
    await flushPromises();

    await act(async () => vi.advanceTimersByTimeAsync(WORKSTREAM_OPEN_TIMEOUT_BASE_MS));
    expect(result.current.state).toBe('reconnecting');
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(getSocketTicket).toHaveBeenCalledTimes(2);
    expect(getSocketTicket.mock.calls[1]?.[6]).toBe(WORKSTREAM_OPEN_TIMEOUT_BASE_MS * 2);

    await act(async () => vi.advanceTimersByTimeAsync(15_000));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.current.openingError).toBeUndefined();
  });

  it.each(['sleep', 'offline'] as const)('replaces a feed across %s without waiting for close', async (transition) => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const id = '00000000-0000-7000-8000-00000000074c';
    const getSocketTicket = vi.fn(async () => ({url: 'wss://api.rally.test/feed',
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket')}));
    const socketApi = socketApiWith({getSocketTicket});
    const {result} = renderHook(() => useWorkstreamSocket(socketApi, id, true), {wrapper: createWrapper()});
    await flushPromises();
    const old = FakeWebSocket.instances[0]!;
    act(() => { old.open(); old.message(snapshotFrame({sequence: 1, workstream: {id}})); });
    vi.spyOn(old, 'close').mockImplementation(() => undefined);
    act(() => {
      if (transition === 'sleep') document.dispatchEvent(new Event('freeze'));
      else window.dispatchEvent(new Event('offline'));
    });
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(getSocketTicket).toHaveBeenCalledTimes(1);
    act(() => {
      if (transition === 'sleep') document.dispatchEvent(new Event('resume'));
      else window.dispatchEvent(new Event('online'));
    });
    await flushPromises();
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => {
      FakeWebSocket.instances[1]!.open();
      FakeWebSocket.instances[1]!.message(snapshotFrame({sequence: 1, workstream: {id}}));
      old.dispatchEvent(Object.assign(new Event('close'), {code: 1006}));
    });
    expect(result.current.state).toBe('connected');
  });

  it.each(['handshake', 'silent open', 'pong without snapshot', 'manual'] as const)(
    'replaces a stranded warm connection: %s, without awaiting close', async (phase) => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const workstreamId = '00000000-0000-7000-8000-00000000074b';
      const api = socketApiWith({ getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
      })) });
      const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
        wrapper: createWrapper(),
      });
      await flushPromises();
      act(() => {
        FakeWebSocket.instances[0]!.open();
        FakeWebSocket.instances[0]!.message(snapshotFrame({
          sequence: 1, workstream: { id: workstreamId, title: 'Opened feed' },
        }));
        FakeWebSocket.instances[0]!.close(1012);
      });
      await act(async () => vi.advanceTimersByTimeAsync(750));
      const stranded = FakeWebSocket.instances[1]!;
      vi.spyOn(stranded, 'close').mockImplementation(() => { stranded.readyState = FakeWebSocket.CLOSING; });
      if (phase === 'silent open' || phase === 'pong without snapshot') act(() => stranded.open());
      if (phase === 'pong without snapshot') {
        act(() => stranded.rawMessage('pong'));
        expect(sentFrames(stranded)).toContainEqual({type: 'request_snapshot'});
      }
      if (phase === 'manual') {
        act(() => result.current.retryOpening());
        await flushPromises();
      } else {
        await act(async () => vi.advanceTimersByTimeAsync(10_000 + 1_500));
      }
      expect(FakeWebSocket.instances).toHaveLength(3);
      const replacement = FakeWebSocket.instances[2]!;
      act(() => {
        replacement.open();
        replacement.rawMessage('pong');
        replacement.message(snapshotFrame({sequence: 1, workstream: {id: workstreamId}}));
        stranded.dispatchEvent(Object.assign(new Event('close'), { code: 1006 }));
      });
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(result.current.state).toBe('connected');
      expect(FakeWebSocket.instances).toHaveLength(3);
    },
  );

  it('recovers a reading-only feed on foreground without a pending command', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApiWith({ getSocketTicket: vi.fn(async () => ({
      url: 'wss://api.rally.test/feed', ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    })) });
    renderHook(() => useWorkstreamSocket(api, 'reading-feed', true), { wrapper: createWrapper() });
    await flushPromises();
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => window.dispatchEvent(new Event('focus')));
    expect(first.send).toHaveBeenCalledWith('ping');
    act(() => first.close(1006));
    act(() => window.dispatchEvent(new Event('focus')));
    await flushPromises();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('times out a stranded reconnect ticket after the feed already opened', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-00000000074a';
    const ticket = {
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    };
    let requestCount = 0;
    const getSocketTicket = vi.fn(() => {
      requestCount += 1;
      if (requestCount === 2) {
        return requestSocketTicket(() => new Promise<typeof ticket>(() => undefined));
      }
      return Promise.resolve(ticket);
    });
    const api = socketApiWith({ getSocketTicket });
    const { result } = renderHook(
      () => useWorkstreamSocket(api, workstreamId, true),
      { wrapper: createWrapper() },
    );
    await flushPromises();
    act(() => {
      FakeWebSocket.instances[0]!.open();
      FakeWebSocket.instances[0]!.message(snapshotFrame({
        sequence: 1,
        workstream: { id: workstreamId, title: 'Opened feed' },
      }));
    });
    expect(result.current.state).toBe('connected');
    act(() => FakeWebSocket.instances[0]!.close(1012));

    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(getSocketTicket).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(WORKSTREAM_OPEN_TIMEOUT_BASE_MS));
    expect(result.current.state).toBe('reconnecting');
    expect(socketTelemetry()).toContainEqual({
      kind: 'realtime_socket_state',
      socket: 'substream_feed',
      state: 'retrying',
      cause: 'ticket_timeout',
      attempts: 'one',
    });
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(getSocketTicket).toHaveBeenCalledTimes(3);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('ignores future feed events and added fields before applying the next snapshot', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-00000000073b';
    const queryClient = new QueryClient();
    const api = socketApiWith({ getSocketTicket: vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    })) });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.message({ type: 'future_feed_event', sequence: 999 });
      socket.message({ ...snapshotFrame({ sequence: 1,
        workstream: { id: workstreamId, title: 'Current snapshot', future: true },
      }), future: true });
    });
    expect(queryClient.getQueryData(['workstream', workstreamId])).toMatchObject({ title: 'Current snapshot' });
    expect(result.current.state).toBe('connected');
  });

  it('starts cacheless retained opens from sequence zero and ignores replay-only frames', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-00000000073b';
    const getSocketTicket = vi.fn(async (
      ...args: Parameters<WorkstreamSocketApi['getSocketTicket']>
    ) => {
      void args;
      return {
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      };
    });
    const api = socketApiWith({ getSocketTicket });
    function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
      return (
        <QueryClientProvider client={queryClient}>
          <WorkstreamSocketResumeProvider scope="user-one:workspace-one">
            {children}
          </WorkstreamSocketResumeProvider>
        </QueryClientProvider>
      );
    }
    const { result, rerender } = renderHook(
      ({ enabled }) => useWorkstreamSocket(api, workstreamId, enabled),
      { initialProps: { enabled: true }, wrapper: Wrapper },
    );

    await flushPromises();
    const firstSocket = FakeWebSocket.instances[0]!;
    act(() => {
      firstSocket.open();
      firstSocket.message(snapshotFrame({
        sequence: 5,
        workstream: { id: workstreamId },
      }));
    });
    rerender({ enabled: false });
    queryClient.removeQueries({ queryKey: ['workstream', workstreamId], exact: true });
    queryClient.removeQueries({ queryKey: ['ordered-transcript', workstreamId], exact: true });
    rerender({ enabled: true });
    await flushPromises();

    expect(getSocketTicket.mock.calls[1]?.[3]).toBe(0);
    const secondSocket = FakeWebSocket.instances[1]!;
    act(() => {
      secondSocket.open();
      secondSocket.message({
        type: 'workstream_renamed',
        sequence: 6,
        occurredAt: '2026-09-01T12:00:00.000Z',
        title: 'Replay without base state',
        titleStatus: 'automatic',
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    expect(result.current.state).toBe('reconnecting');
    expect(secondSocket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('accepts canonical socket caches that arrive at the opening deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-00000000073c';
    const getSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    queryClient.setQueryData(['workstream', workstreamId], workstreamDetail({ id: workstreamId }));
    queryClient.setQueryData(['ordered-transcript', workstreamId], emptyTranscriptSnapshot());
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await act(async () => vi.advanceTimersByTimeAsync(750));

    expect(result.current.openingError).toBeUndefined();
    expect(getSocketTicket).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(result.current.openingError).toBeUndefined();
    // Cached content keeps recovery automatic; it cannot excuse a new stuck dial.
    expect(getSocketTicket.mock.calls.length).toBeGreaterThan(2);
  });

  it.each([
    ['main', '0', 'history_unavailable'],
    ['main', '0', 'sequence_ahead'],
    ['child', '00000000-0000-7000-8000-00000000073e', 'history_unavailable'],
    ['child', '00000000-0000-7000-8000-00000000073e', 'sequence_ahead'],
  ] as const)('resets a %s conversation after %s through its own authoritative socket', async (
    _kind,
    substreamId,
    reason,
  ) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-00000000073d';
    const queryClient = new QueryClient();
    const getSocketTicket = vi.fn(async (
      ...args: Parameters<WorkstreamSocketApi['getSocketTicket']>
    ) => {
      void args;
      return {
        url: `wss://api.rally.test/workstreams/${workstreamId}/${substreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      };
    });
    const api = socketApiWith({
      getSocketTicket,
    });
    const { result } = renderHook(() => useWorkstreamSocket(
      api, workstreamId, true, 'active_workstream', undefined, true, substreamId,
    ), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    const first = FakeWebSocket.instances[0]!;
    act(() => {
      first.open();
      first.message(snapshotFrame({
        sequence: 13,
        workstream: { id: workstreamId, title: 'Old baseline' },
        pendingInputChunkCount: 2,
      }));
    });
    const range = result.current.loadTranscriptRange({
      snapshotId: '00000000-0000-7000-8000-000000000777',
      range: { startInclusive: 1, endExclusive: 2 },
      resumeAfterEventSequence: 13,
    }).then(() => null, (error: unknown) => error);
    act(() => {
      first.message({
        type: 'resync_required',
        sequence: 14,
        latestSequence: 14,
        occurredAt: '2026-09-01T12:00:00.000Z',
        reason,
        activeStreams: [],
        activeCompaction: null,
      });
    });
    await expect(range).resolves.toMatchObject({ code: 'workstream_socket_unavailable' });
    expect(result.current.sendReady).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(750));
    await flushPromises();

    expect(getSocketTicket).toHaveBeenCalledTimes(2);
    expect(getSocketTicket.mock.calls[1]?.[1]).toBe(substreamId);
    expect(getSocketTicket.mock.calls[1]?.[3]).toBe(0);
    const second = FakeWebSocket.instances[1]!;
    // A stale generation cannot complete the abandoned pending-input assembly
    // or replace the baseline while the fresh admitted socket is opening.
    act(() => first.message({
      type: 'pending_inputs_snapshot_chunk',
      sequence: 13,
      occurredAt: '2026-07-31T20:00:00.000Z',
      snapshotId: '00000000-0000-7000-8000-000000000777',
      chunkIndex: 0,
      chunkCount: 2,
      inputs: [pendingInput(1, 'stale pending input')],
    }));
    const detailKey = substreamId === '0'
      ? ['workstream', workstreamId]
      : ['substream-workstream', workstreamId, substreamId];
    expect(queryClient.getQueryData<WorkstreamDetail>(detailKey)?.title).toBe('Old baseline');
    act(() => {
      second.open();
      second.message(snapshotFrame({
        sequence: 2,
        reason: 'history_unavailable',
        workstream: { id: workstreamId, title: 'New baseline' },
      }));
    });
    expect(result.current.sendReady).toBe(true);
    expect(queryClient.getQueryData<WorkstreamDetail>(detailKey)?.title).toBe('New baseline');
  });

  it('installs an oversized authoritative pending snapshot only after every ordered chunk arrives', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-00000000062f';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const transcript = {
      ...emptyTranscriptSnapshot(),
      snapshotId: '00000000-0000-7000-8000-00000000072f',
    };
    const previous = pendingInput(9, 'previous authority');
    act(() => socket.message({
      type: 'loop_input_upserted',
      sequence: 1,
      occurredAt: '2026-07-31T19:20:00.000Z',
      input: previous,
    }));
    act(() => socket.message(snapshotFrame({
      sequence: 2,
      transcript,
      pendingInputChunkCount: 2,
    })));
    expect(overlayMessages(queryClient, workstreamId).map((message) => message.text))
      .toEqual(['previous authority']);

    const second = pendingInput(2, 'second');
    act(() => socket.message({
      type: 'pending_inputs_snapshot_chunk',
      sequence: 2,
      occurredAt: '2026-07-31T19:20:00.000Z',
      snapshotId: transcript.snapshotId,
      chunkIndex: 1,
      chunkCount: 2,
      inputs: [second],
    }));
    expect(overlayMessages(queryClient, workstreamId).map((message) => message.text))
      .toEqual(['previous authority']);

    const first = pendingInput(1, 'first');
    act(() => socket.message({
      type: 'pending_inputs_snapshot_chunk',
      sequence: 2,
      occurredAt: '2026-07-31T19:20:00.000Z',
      snapshotId: transcript.snapshotId,
      chunkIndex: 0,
      chunkCount: 2,
      inputs: [first],
    }));
    expect(overlayMessages(queryClient, workstreamId).map((message) => message.text))
      .toEqual(['first', 'second']);
    expect(queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', workstreamId],
    )?.pendingInputs).toEqual([first, second]);
  });

  it('restarts from a baseline after a partial initial-context close', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-00000000063a';
    const substreamId = '00000000-0000-7000-8000-00000000063b';
    const getSocketTicket = vi.fn(async (
      ...args: Parameters<WorkstreamSocketApi['getSocketTicket']>
    ) => {
      void args;
      return {
      url: `wss://api.rally.test/workstreams/${workstreamId}/${substreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
      };
    });
    const { result } = renderHook(() => useWorkstreamSocket(
      socketApiWith({ getSocketTicket }), workstreamId, true,
      'active_workstream', undefined, true, substreamId,
    ), { wrapper: createWrapper(queryClient) });
    await flushPromises();
    const first = FakeWebSocket.instances[0]!;
    act(() => {
      first.open();
      first.message(snapshotFrame({
        sequence: 8, initialContextChunkCount: 2, workstream: { id: workstreamId },
      }));
      first.message({
        type: 'initial_context_snapshot_chunk', sequence: 8,
        occurredAt: '2026-07-31T19:20:00.000Z',
        snapshotId: emptyTranscriptSnapshot().snapshotId,
        chunkIndex: 0, chunkCount: 2, json: '{"stale":',
      });
    });
    expect(result.current.sendReady).toBe(false);
    act(() => first.close(1006));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    await flushPromises();

    expect(getSocketTicket.mock.calls[1]?.[3]).toBe(0);
    expect(result.current.sendReady).toBe(false);
    expect(queryClient.getQueryData(substreamInitialContextQueryKey(workstreamId, substreamId)))
      .toBeUndefined();
  });

  it('requires every initial-context chunk before a child becomes send-ready', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-00000000063d';
    const substreamId = '00000000-0000-7000-8000-00000000063e';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}/${substreamId}`,
        ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(() => useWorkstreamSocket(
      api, workstreamId, true, 'active_workstream', undefined, true, substreamId,
    ), { wrapper: createWrapper(queryClient) });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    const context = {
      source: { workspaceId: '00000000-0000-7000-8000-00000000063c', workstreamId, substreamId: '0' },
      throughTurnId: null,
      policyRevision: 'policy-1',
      contentHash: 'a'.repeat(64),
      parts: [{ kind: 'summary', text: 'Inherited', requestedModel: 'model', resolvedModel: 'model', inputTokens: 1, outputTokens: 1 }],
    };
    const encoded = JSON.stringify(context);
    act(() => {
      socket.open();
      socket.message(snapshotFrame({
        sequence: 1, initialContextChunkCount: 2, workstream: { id: workstreamId },
      }));
      socket.message({
        type: 'initial_context_snapshot_chunk', sequence: 1,
        occurredAt: '2026-07-31T19:20:00.000Z', snapshotId: emptyTranscriptSnapshot().snapshotId,
        chunkIndex: 1, chunkCount: 2, json: encoded.slice(Math.floor(encoded.length / 2)),
      });
    });
    expect(result.current.sendReady).toBe(false);
    act(() => socket.message({
      type: 'initial_context_snapshot_chunk', sequence: 1,
      occurredAt: '2026-07-31T19:20:00.000Z', snapshotId: emptyTranscriptSnapshot().snapshotId,
      chunkIndex: 0, chunkCount: 2, json: encoded.slice(0, Math.floor(encoded.length / 2)),
    }));
    expect(queryClient.getQueryData(substreamInitialContextQueryKey(workstreamId, substreamId)))
      .toEqual(context);
    expect(result.current.sendReady).toBe(true);
  });

  it('requests a fresh snapshot when a complete initial-context assembly is malformed', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-00000000064a';
    const substreamId = '00000000-0000-7000-8000-00000000064b';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}/${substreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(
      api, workstreamId, true,
      'active_workstream', undefined, true, substreamId,
    ), { wrapper: createWrapper(queryClient) });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.message(snapshotFrame({
        sequence: 1, initialContextChunkCount: 1, workstream: { id: workstreamId },
      }));
      socket.message({
        type: 'initial_context_snapshot_chunk', sequence: 1,
        occurredAt: '2026-07-31T19:20:00.000Z', snapshotId: emptyTranscriptSnapshot().snapshotId,
        chunkIndex: 0, chunkCount: 1, json: '{not-json',
      });
    });

    expect(sentFrames(socket).at(-1)).toEqual({ type: 'request_snapshot' });
    expect(queryClient.getQueryData(substreamInitialContextQueryKey(workstreamId, substreamId)))
      .toBeUndefined();
  });

  it('reuses the same socket when returning to a recently viewed channel', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000621';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000622';
    const queryClient = new QueryClient();
    for (const workstreamId of [firstWorkstreamId, secondWorkstreamId]) {
      queryClient.setQueryData(['workstream', workstreamId], workstreamDetail({ id: workstreamId }));
      queryClient.setQueryData(['ordered-transcript', workstreamId], emptyTranscriptSnapshot());
    }
    const api = socketApiWith({
      getSocketTicket: vi.fn(async (workstreamId: string) => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: `socket-ticket-${workstreamId}`,
        protocols: socketTicketProtocols(`socket-ticket-${workstreamId}`),
      })),
    });
    function ActiveConnection({ workstreamId }: { workstreamId: string }): React.JSX.Element {
      const connection = useRetainedWorkstreamSocket(api, workstreamId, true);
      return <div>{connection.state}</div>;
    }
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={firstWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection workstreamId={firstWorkstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper(queryClient) },
    );
    await flushPromises();
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.send.mockImplementation((frame: string) => {
      if (frame === 'ping') queueMicrotask(() => firstSocket.rawMessage('pong'));
      else if (frame.includes('request_snapshot')) queueMicrotask(() => firstSocket.message(snapshotFrame({
        sequence: 1, workstream: {id: firstWorkstreamId},
      })));
    });
    act(() => firstSocket.open());
    await flushPromises();
    const firstClose = vi.spyOn(firstSocket, 'close');

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    const secondSocket = FakeWebSocket.instances[1]!;
    secondSocket.send.mockImplementation((frame: string) => {
      if (frame === 'ping') queueMicrotask(() => secondSocket.rawMessage('pong'));
      else if (frame.includes('request_snapshot')) queueMicrotask(() => secondSocket.message(snapshotFrame({
        sequence: 1, workstream: {id: secondWorkstreamId},
      })));
    });
    act(() => secondSocket.open());
    await flushPromises();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(firstClose).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(RECENT_WORKSTREAM_SOCKET_RETENTION_MS - 1));
    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={firstWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection workstreamId={firstWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(firstClose).not.toHaveBeenCalled();
  });

  it('closes an idle recently viewed socket only after five minutes', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000623';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000624';
    const queryClient = new QueryClient();
    for (const workstreamId of [firstWorkstreamId, secondWorkstreamId]) {
      queryClient.setQueryData(['workstream', workstreamId], workstreamDetail({ id: workstreamId }));
      queryClient.setQueryData(['ordered-transcript', workstreamId], emptyTranscriptSnapshot());
    }
    const api = socketApiWith({
      getSocketTicket: vi.fn(async (workstreamId: string) => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: `socket-ticket-${workstreamId}`,
        protocols: socketTicketProtocols(`socket-ticket-${workstreamId}`),
      })),
    });
    function ActiveConnection({ workstreamId }: { workstreamId: string }): React.JSX.Element {
      const connection = useRetainedWorkstreamSocket(api, workstreamId, true);
      return <div>{connection.state}</div>;
    }
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={firstWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection workstreamId={firstWorkstreamId} />
      </WorkstreamSocketPool>,
      { wrapper: createWrapper(queryClient) },
    );
    await flushPromises();
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.send.mockImplementation((frame: string) => {
      if (frame === 'ping') queueMicrotask(() => firstSocket.rawMessage('pong'));
      else if (frame.includes('request_snapshot')) queueMicrotask(() => firstSocket.message(snapshotFrame({
        sequence: 1, workstream: {id: firstWorkstreamId},
      })));
    });
    act(() => firstSocket.open());
    await flushPromises();
    const firstClose = vi.spyOn(firstSocket, 'close');

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    await act(async () => vi.advanceTimersByTimeAsync(RECENT_WORKSTREAM_SOCKET_RETENTION_MS - 1));
    expect(firstClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(firstClose).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'manual'] as const)('preserves a pending message and its receipt across %s recovery', async (recovery) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000601';
    const turnId = '00000000-0000-7000-8000-000000000604';
    const clientMessageId = 'client-message-reconnect';
    const acceptedTurn = {
      turnId,
      clientMessageId,
      createdAt: '2026-08-17T12:00:01.000Z',
      deliveryState: 'canonical' as const,
    };
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
      messageMentionPayload: vi.fn(async () => []),
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(),
    });

    await flushPromises();
    expect(result.current.sendReady).toBe(true);
    expect(result.current.workspaceSocketState).toBe('connecting');
    const admission = result.current.createMessage({
        text: 'Please continue.',
        clientId: clientMessageId,
        runMode: 'queue',
      });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const firstCommand = sentFrames(socket).find((frame): frame is Extract<ClientSocketEvent, {
      type: 'create_message';
    }> => frame.type === 'create_message');
    expect(firstCommand).toEqual(expect.objectContaining({
      type: 'create_message',
      payload: {
        text: 'Please continue.',
        clientMessageId,
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
        runMode: 'queue',
      },
    }));
    if (recovery === 'manual') act(() => result.current.retryOpening());
    else {
      act(() => socket.close(1006));
      act(() => vi.advanceTimersByTime(750));
    }
    await flushPromises();
    const reconnectedSocket = FakeWebSocket.instances[1]!;
    act(() => reconnectedSocket.open());
    expect(sentFrames(reconnectedSocket).find((frame) => frame.type === 'create_message'))
      .toEqual(firstCommand);
    act(() => reconnectedSocket.message({
      type: 'client_command_succeeded',
      command: 'create_message',
      operationId: firstCommand?.operationId,
      clientMessageId,
      turn: {
        turnId,
        clientMessageId,
        createdAt: acceptedTurn.createdAt,
      },
      deliveryState: 'canonical',
    }));
    await expect(admission).resolves.toEqual(acceptedTurn);
  });

  it('sends each new command once on a healthy socket', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000605';
    const queryClient = new QueryClient();
    const roster = [{
      id: '00000000-0000-7000-8000-000000000606',
      name: 'Adam',
      email: 'adam@example.com',
      timezone: 'America/Los_Angeles',
      status: 'active' as const,
    }];
    queryClient.setQueryData(['workspace-members'], roster);
    const messageMentionPayload = vi.fn(async () => []);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
      messageMentionPayload,
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const first = result.current.createMessage({
      text: 'Ask @Adam first.',
      clientId: 'client-message-healthy-1',
    });
    await flushPromises();
    const second = result.current.createMessage({
      text: 'Then continue.',
      clientId: 'client-message-healthy-2',
    });
    await flushPromises();

    const commands = sentFrames(socket).filter((frame): frame is Extract<ClientSocketEvent, {
      type: 'create_message';
    }> => frame.type === 'create_message');
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.payload.clientMessageId)).toEqual([
      'client-message-healthy-1',
      'client-message-healthy-2',
    ]);
    expect(messageMentionPayload).toHaveBeenNthCalledWith(1, 'Ask @Adam first.', undefined, roster);

    for (const command of commands) {
      act(() => socket.message({
        type: 'client_command_succeeded',
        command: 'create_message',
        operationId: command.operationId,
        clientMessageId: command.payload.clientMessageId,
        turn: {
          turnId: `${command.payload.clientMessageId}-turn`,
          clientMessageId: command.payload.clientMessageId,
          createdAt: '2026-09-17T12:00:00.000Z',
        },
        deliveryState: 'canonical',
      }));
    }
    await Promise.all([first, second]);
  });

  it('reconciles and replays an unresolved command on application foreground', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const workstreamId = '00000000-0000-7000-8000-000000000607';
    const clientMessageId = 'client-message-foreground-recovery';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(),
    });

    try {
      await flushPromises();
      const socket = FakeWebSocket.instances[0]!;
      act(() => socket.open());
      const admission = result.current.createMessage({
        text: 'Recover this message.',
        clientId: clientMessageId,
      });
      await flushPromises();
      const firstCommand = sentFrames(socket).find((frame): frame is Extract<ClientSocketEvent, {
        type: 'create_message';
      }> => frame.type === 'create_message');
      expect(firstCommand).toBeDefined();
      expect(sentFrames(socket).filter((frame) => frame.type === 'create_message')).toHaveLength(1);

      act(() => window.dispatchEvent(new Event('focus')));

      const foregroundFrames = sentFrames(socket);
      expect(foregroundFrames.filter((frame) => frame.type === 'create_message')).toEqual([
        firstCommand,
        firstCommand,
      ]);
      expect(foregroundFrames.filter((frame) => frame.type === 'request_snapshot')).toHaveLength(1);
      expect(socket.send).toHaveBeenCalledWith('ping');
      expect(socket.send.mock.calls.filter(([frame]) => frame === 'ping')).toHaveLength(1);

      // A second focus event cannot replace the older liveness deadline.
      act(() => window.dispatchEvent(new Event('focus')));
      expect(socket.send.mock.calls.filter(([frame]) => frame === 'ping')).toHaveLength(1);

      act(() => socket.rawMessage('pong'));
      act(() => socket.message({
        type: 'client_command_succeeded',
        command: 'create_message',
        operationId: firstCommand!.operationId,
        clientMessageId,
        turn: {
          turnId: '00000000-0000-7000-8000-000000000608',
          clientMessageId,
          createdAt: '2026-09-17T12:00:00.000Z',
        },
        deliveryState: 'canonical',
      }));
      await expect(admission).resolves.toMatchObject({ clientMessageId, deliveryState: 'canonical' });

      const settledCallCount = socket.send.mock.calls.length;
      act(() => window.dispatchEvent(new Event('focus')));
      expect(socket.send).toHaveBeenCalledTimes(settledCallCount + 1);
      expect(socket.send).toHaveBeenLastCalledWith('ping');
    } finally {
      hasFocus.mockRestore();
    }
  });

  it('reconnects immediately on application foreground when a command lost its socket', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000609';
    const clientMessageId = 'client-message-foreground-reconnect';
    const getSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(),
    });

    await flushPromises();
    const firstSocket = FakeWebSocket.instances[0]!;
    act(() => firstSocket.open());
    const admission = result.current.createMessage({
      text: 'Recover after close.',
      clientId: clientMessageId,
    });
    await flushPromises();
    const command = sentFrames(firstSocket).find((frame): frame is Extract<ClientSocketEvent, {
      type: 'create_message';
    }> => frame.type === 'create_message')!;
    act(() => firstSocket.close(1006));
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => window.dispatchEvent(new Event('focus')));
    await flushPromises();
    expect(getSocketTicket).toHaveBeenCalledTimes(2);
    const recoveredSocket = FakeWebSocket.instances[1]!;
    act(() => recoveredSocket.open());
    expect(sentFrames(recoveredSocket).filter((frame) => frame.type === 'create_message')).toEqual([command]);
    act(() => recoveredSocket.message({
      type: 'client_command_succeeded',
      command: 'create_message',
      operationId: command.operationId,
      clientMessageId,
      turn: {
        turnId: '00000000-0000-7000-8000-000000000610',
        clientMessageId,
        createdAt: '2026-09-17T12:00:00.000Z',
      },
      deliveryState: 'canonical',
    }));
    await expect(admission).resolves.toMatchObject({ clientMessageId, deliveryState: 'canonical' });
  });

  it('orders appearance choices and never sends queued choices to a newly selected room', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000631';
    const api = socketApiWith({ getSocketTicket: vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    })) });
    const queryClient = new QueryClient();
    const appearance = { icon: 'atom', color: 'gray' } as const;
    setCachedWorkstreams(queryClient, [workstreamSummary({ id: workstreamId, appearance })]);
    queryClient.setQueryData(['workstream', workstreamId], workstreamDetail({ id: workstreamId, appearance }));
    const { result, rerender } = renderHook(({ id }) => useWorkstreamSocket(api, id, true), {
      initialProps: { id: workstreamId }, wrapper: createWrapper(queryClient),
    });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const color = result.current.setAppearance({ color: 'purple' });
    const icon = result.current.setAppearance({ icon: 'rocket' });
    await flushPromises();
    const commands = sentFrames(socket).filter((frame) => frame.type === 'set_workstream_appearance');
    expect(commands).toHaveLength(1);
    // Nothing moves on a sent command: the sidebar shows a committed value or
    // the old one, never a choice the room may still refuse.
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.appearance).toEqual(appearance);
    const first = commands[0]!;
    act(() => socket.message({ type: 'client_command_succeeded', command: 'set_workstream_appearance', operationId: first.operationId }));
    await color;
    await flushPromises();
    // The receipt is the commit, and the sidebar row takes it without waiting
    // for the directory projection. The patch merges over the current value,
    // so the color choice keeps the icon. The detail entry is left to the
    // versioned push: the header shows the picker's own preview until then,
    // and moving the detail here would retire that preview early.
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.appearance)
      .toEqual({ icon: 'atom', color: 'purple' });
    expect(queryDetail(queryClient, workstreamId)?.appearance).toEqual(appearance);
    expect(sentFrames(socket).filter((frame) => frame.type === 'set_workstream_appearance')).toHaveLength(2);
    const queued = result.current.setAppearance({ color: 'blue' });
    const rejectedIcon = expect(icon).rejects.toMatchObject({ code: 'workstream_socket_unavailable' });
    const rejectedQueued = expect(queued).rejects.toMatchObject({ code: 'workstream_socket_unavailable' });
    rerender({ id: '00000000-0000-7000-8000-000000000632' });
    await flushPromises();
    await rejectedIcon;
    await rejectedQueued;
    const next = FakeWebSocket.instances.at(-1)!;
    act(() => next.open());
    expect(sentFrames(next).filter((frame) => frame.type === 'set_workstream_appearance')).toEqual([]);
  });

  it('does not apply an appearance receipt that crossed a reconnect over newer cached state', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000633';
    const api = socketApiWith({ getSocketTicket: vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    })) });
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [workstreamSummary({ id: workstreamId, appearance: { icon: 'atom', color: 'gray' } })]);
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const choice = result.current.setAppearance({ color: 'purple' });
    await flushPromises();
    const sent = sentFrames(socket).find((frame) => frame.type === 'set_workstream_appearance');
    expect(sent).toBeDefined();
    // The room committed the choice but the receipt was lost with the connection.
    act(() => socket.close(1006));
    act(() => vi.advanceTimersByTime(750));
    await flushPromises();
    const reconnected = FakeWebSocket.instances[1]!;
    act(() => reconnected.open());
    await flushPromises();
    expect(sentFrames(reconnected).find((frame) => frame.type === 'set_workstream_appearance')).toEqual(sent);
    // Meanwhile another client chose blue and its newer versioned state arrived.
    setCachedWorkstreams(queryClient, [workstreamSummary({ id: workstreamId, appearance: { icon: 'atom', color: 'blue' } })]);
    act(() => reconnected.message({ type: 'client_command_succeeded', command: 'set_workstream_appearance', operationId: sent!.operationId }));
    await expect(choice).resolves.toBeUndefined();
    await flushPromises();
    // The replayed receipt answers the resend; it says nothing about which
    // choice the room holds now, so the newer cached value stands.
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.appearance).toEqual({ icon: 'atom', color: 'blue' });
  });

  it('sends child-local commands to the addressed breakout and resends them until receipt', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000621';
    const substreamId = '00000000-0000-7000-8000-000000000622';
    const elicitationId = '00000000-0000-7000-8000-000000000623';
    const retryRunId = '00000000-0000-7000-8000-000000000624';
    const getSocketTicket = vi.fn(async (
      ...args: Parameters<WorkstreamSocketApi['getSocketTicket']>
    ) => {
      void args;
      return {
        url: `wss://api.rally.test/workstreams/${workstreamId}/substreams/${substreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      };
    });
    const api = socketApiWith({ getSocketTicket });
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [workstreamSummary({
      id: workstreamId,
      appearance: { icon: 'atom', color: 'gray' },
    })]);
    queryClient.setQueryData(['workstream-children', workstreamId], {
      privateChildren: [{ substreamId, title: 'Private child' }],
    });
    queryClient.setQueryData(['substream-workstream', workstreamId, substreamId], workstreamDetail({
      id: workstreamId,
      appearance: { icon: 'orbit', color: 'green' },
    }));
    const { result } = renderHook(() => useWorkstreamSocket(
      api,
      workstreamId,
      true,
      'active_workstream',
      undefined,
      true,
      substreamId,
    ), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    expect(getSocketTicket).toHaveBeenCalledWith(
      workstreamId,
      substreamId,
      expect.any(String),
      0,
      false,
      expect.any(AbortSignal),
      WORKSTREAM_OPEN_TIMEOUT_BASE_MS,
    );
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());

    const stop = result.current.stopHarness();
    await flushPromises();
    const stopCommand = sentFrames(first).find((frame): frame is Extract<ClientSocketEvent, {
      type: 'stop_harness';
    }> => frame.type === 'stop_harness')!;
    act(() => first.close(1006));
    act(() => vi.advanceTimersByTime(750));
    await flushPromises();
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    expect(sentFrames(second)).toContainEqual(stopCommand);
    act(() => second.message({
      type: 'client_command_succeeded',
      command: 'stop_harness',
      operationId: stopCommand.operationId,
    }));
    await expect(stop).resolves.toBeUndefined();

    const answer = result.current.answerElicitation(elicitationId, 'Ship it');
    await flushPromises();
    const answerCommand = sentFrames(second).find((frame): frame is Extract<ClientSocketEvent, {
      type: 'answer_elicitation';
    }> => frame.type === 'answer_elicitation')!;
    expect(answerCommand).toMatchObject({ elicitationId, payload: { answer: 'Ship it' } });
    act(() => second.message({
      type: 'client_command_succeeded',
      command: 'answer_elicitation',
      operationId: answerCommand.operationId,
    }));
    await expect(answer).resolves.toBeUndefined();

    const reorder = result.current.reorderPendingInputs([elicitationId]);
    await flushPromises();
    const reorderCommand = sentFrames(second).find((frame): frame is Extract<ClientSocketEvent, {
      type: 'reorder_pending_inputs';
    }> => frame.type === 'reorder_pending_inputs')!;
    act(() => second.message({
      type: 'client_command_succeeded',
      command: 'reorder_pending_inputs',
      operationId: reorderCommand.operationId,
      pendingInputs: [],
    }));
    await expect(reorder).resolves.toEqual({ pendingInputs: [] });

    const retry = result.current.retryHarness();
    await flushPromises();
    const retryCommand = sentFrames(second).find((frame): frame is Extract<ClientSocketEvent, {
      type: 'retry_harness';
    }> => frame.type === 'retry_harness')!;
    act(() => second.message({
      type: 'client_command_succeeded',
      command: 'retry_harness',
      operationId: retryCommand.operationId,
      harnessRunId: retryRunId,
    }));
    await expect(retry).resolves.toEqual({ harnessRunId: retryRunId });

    const appearance = result.current.setAppearance({ color: 'purple' });
    await flushPromises();
    const appearanceCommand = sentFrames(second).find((frame): frame is Extract<ClientSocketEvent, {
      type: 'set_workstream_appearance';
    }> => frame.type === 'set_workstream_appearance')!;
    act(() => second.message({
      type: 'client_command_succeeded',
      command: 'set_workstream_appearance',
      operationId: appearanceCommand.operationId,
    }));
    await expect(appearance).resolves.toBeUndefined();
    expect(queryClient.getQueryData<{ privateChildren: Array<{ appearance?: unknown }> }>(
      ['workstream-children', workstreamId],
    )?.privateChildren[0]?.appearance).toEqual({ icon: 'orbit', color: 'purple' });
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.appearance)
      .toEqual({ icon: 'atom', color: 'gray' });

    const lateAppearance = result.current.setAppearance({ icon: 'rocket' });
    await flushPromises();
    const lateAppearanceCommand = sentFrames(second).filter((frame): frame is Extract<ClientSocketEvent, {
      type: 'set_workstream_appearance';
    }> => frame.type === 'set_workstream_appearance').at(-1)!;
    // Another authoritative parent projection lands while this receipt is in
    // flight. The receipt only confirms the older command and must not regress
    // the newer row.
    queryClient.setQueryData(['workstream-children', workstreamId], {
      privateChildren: [{ substreamId, title: 'Private child', appearance: { icon: 'heart', color: 'blue' } }],
    });
    act(() => second.message({
      type: 'client_command_succeeded',
      command: 'set_workstream_appearance',
      operationId: lateAppearanceCommand.operationId,
    }));
    await expect(lateAppearance).resolves.toBeUndefined();
    expect(queryClient.getQueryData<{ privateChildren: Array<{ appearance?: unknown }> }>(
      ['workstream-children', workstreamId],
    )?.privateChildren[0]?.appearance).toEqual({ icon: 'heart', color: 'blue' });
  });

  it('rejects failed and mismatched private command receipts', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000627';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(),
    });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const stopped = result.current.stopHarness();
    await flushPromises();
    const stopCommand = sentFrames(socket).find((frame): frame is Extract<ClientSocketEvent, {
      type: 'stop_harness';
    }> => frame.type === 'stop_harness')!;
    act(() => socket.message({
      type: 'client_command_failed',
      command: 'stop_harness',
      operationId: stopCommand.operationId,
      error: { status: 409, code: 'execution_changed', message: 'Execution changed.' },
    }));
    await expect(stopped).rejects.toMatchObject({
      status: 409,
      code: 'execution_changed',
      message: 'Execution changed.',
    });

    const retried = result.current.retryHarness();
    await flushPromises();
    const retryCommand = sentFrames(socket).find((frame): frame is Extract<ClientSocketEvent, {
      type: 'retry_harness';
    }> => frame.type === 'retry_harness')!;
    act(() => socket.message({
      type: 'client_command_succeeded',
      command: 'stop_harness',
      operationId: retryCommand.operationId,
    }));
    await expect(retried).rejects.toMatchObject({
      status: 500,
      code: 'substream_command_receipt_mismatch',
    });
  });

  it('preserves the control-owned private child directory across a main feed snapshot', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000623';
    const child = {
      substreamId: '00000000-0000-7000-8000-000000000624',
      title: 'Ready child',
      createdByUserId: '00000000-0000-7000-8000-000000000002',
      createdAt: '2026-09-04T12:00:00.000Z',
      updatedAt: '2026-09-04T12:00:00.000Z',
    };
    queryClient.setQueryData(['workstream', workstreamId], workstreamDetail({
      id: workstreamId,
      title: 'Control title',
    }));
    queryClient.setQueryData(['workstream-children', workstreamId], { privateChildren: [child] });
    const api = socketApiWith({ getSocketTicket: vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    })) });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.message(snapshotFrame({
        sequence: 1,
        workstream: { id: workstreamId, title: 'Feed title' },
      }));
    });
    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId]))
      .toMatchObject({ title: 'Feed title' });
    expect(queryClient.getQueryData(['workstream-children', workstreamId]))
      .toEqual({ privateChildren: [child] });
  });

  it('isolates a child feed from the main cache and recovers it through its own socket', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000625';
    const substreamId = '00000000-0000-7000-8000-000000000626';
    const mainDetail = workstreamDetail({ id: workstreamId, title: 'Main conversation' });
    const mainTranscript = emptyTranscriptSnapshot();
    queryClient.setQueryData(['workstream', workstreamId], mainDetail);
    queryClient.setQueryData(['ordered-transcript', workstreamId], mainTranscript);
    queryClient.setQueryData(['transcript-overlays', workstreamId], [{ main: true }]);
    setCachedWorkstreams(queryClient, [{
      ...mainDetail,
      title: 'Parent sidebar row',
    }]);
    const getSocketTicket = vi.fn((
      ...args: Parameters<WorkstreamSocketApi['getSocketTicket']>
    ) => {
      void args;
      return Promise.resolve({
        url: `wss://api.rally.test/workstreams/${workstreamId}/substreams/${substreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      });
    });
    const api = socketApiWith({ getSocketTicket });
    const { result } = renderHook(() => useWorkstreamSocket(
      api,
      workstreamId,
      true,
      'active_workstream',
      undefined,
      true,
      substreamId,
    ), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const first = FakeWebSocket.instances[0]!;
    act(() => {
      first.open();
      first.message(snapshotFrame({
        sequence: 5,
        workstream: { id: workstreamId, title: 'Child conversation' },
      }));
    });

    expect(queryClient.getQueryData(['workstream', workstreamId])).toBe(mainDetail);
    expect(queryClient.getQueryData(['ordered-transcript', workstreamId])).toBe(mainTranscript);
    expect(queryClient.getQueryData(['transcript-overlays', workstreamId])).toEqual([{ main: true }]);
    expect(queryClient.getQueryData(['substream-workstream', workstreamId, substreamId]))
      .toMatchObject({ title: 'Child conversation' });
    expect(queryClient.getQueryData(['substream-ordered-transcript', workstreamId, substreamId]))
      .toEqual(emptyTranscriptSnapshot());

    act(() => first.message({
      type: 'transcript_turn_upserted',
      sequence: 6,
      occurredAt: '2026-07-31T20:00:00.000Z',
      turn: transcriptTurn(1, 'Child-only turn'),
    }));
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.title)
      .toBe('Parent sidebar row');

    act(() => first.message({
      type: 'resync_required',
      sequence: 7,
      latestSequence: 7,
      occurredAt: '2026-07-31T20:00:00.000Z',
      reason: 'history_unavailable',
      activeStreams: [],
      activeCompaction: null,
    }));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    await flushPromises();

    expect(getSocketTicket).toHaveBeenCalledTimes(2);
    expect(getSocketTicket.mock.calls[1]?.[1]).toBe(substreamId);
    expect(getSocketTicket.mock.calls[1]?.[3]).toBe(0);

    queryClient.setQueryData(
      ['substream-transcript-overlays', workstreamId, substreamId],
      [{ child: true }],
    );
    queryClient.setQueryData(
      ['substream-workstream-feed-source', workstreamId, substreamId],
      'socket_snapshot',
    );
    queryClient.setQueryData(
      ['substream-workstream-socket-snapshot-generation', workstreamId, substreamId],
      1,
    );
    act(() => FakeWebSocket.instances[1]!.close(1008));
    await flushPromises();
    expect(queryClient.getQueryData(['workstream', workstreamId])).toBe(mainDetail);
    expect(queryClient.getQueryData(['substream-workstream', workstreamId, substreamId]))
      .toBeUndefined();
    expect(queryClient.getQueryData(['substream-ordered-transcript', workstreamId, substreamId]))
      .toBeUndefined();
    expect(queryClient.getQueryData(['substream-transcript-overlays', workstreamId, substreamId]))
      .toBeUndefined();
    expect(queryClient.getQueryData(['substream-workstream-feed-source', workstreamId, substreamId]))
      .toBeUndefined();
    expect(queryClient.getQueryData([
      'substream-workstream-socket-snapshot-generation', workstreamId, substreamId,
    ])).toBeUndefined();
    await expect(result.current.stopHarness()).rejects.toMatchObject({
      status: 403,
      code: 'workstream_access_revoked',
    });
    expect(result.current.sendReady).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('rejects a pending message when an older worker returns an uncorrelated command error', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000605';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
      messageMentionPayload: vi.fn(async () => []),
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const admission = result.current.createMessage({
      text: 'Please continue.',
      clientId: 'client-message-old-worker-error',
      runMode: 'queue',
    });
    await flushPromises();
    act(() => socket.message({
      type: 'error',
      sequence: 0,
      occurredAt: '2026-09-01T12:00:00.000Z',
      code: 'workspace_socket_required',
      message: 'Reconnect before sending messages.',
    }));

    await expect(admission).rejects.toMatchObject({ code: 'workspace_socket_required' });
  });

  it('shows durable compaction activity and ignores a stale finish', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000611';
    const harnessRunId = '00000000-0000-7000-8000-000000000612';
    const attemptId = '00000000-0000-7000-8000-000000000613';
    const recoveredAttemptId = '00000000-0000-7000-8000-000000000614';
    const startedAt = '2026-08-18T12:00:00.000Z';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'compaction_started',
      sequence: 1,
      occurredAt: startedAt,
      compaction: {
        harnessRunId,
        attemptId,
        compactionIndex: 1,
        trigger: 'auto',
        startedAt,
      },
    }));
    expect(result.current.activeCompaction).toEqual({
      harnessRunId,
      attemptId,
      compactionIndex: 1,
      trigger: 'auto',
      startedAt,
    });

    act(() => socket.message({
      type: 'compaction_started',
      sequence: 2,
      occurredAt: startedAt,
      compaction: {
        harnessRunId,
        attemptId: recoveredAttemptId,
        compactionIndex: 1,
        trigger: 'manual',
        startedAt,
      },
    }));
    act(() => socket.message({
      type: 'compaction_finished',
      sequence: 3,
      occurredAt: startedAt,
      harnessRunId,
      attemptId,
      compactionIndex: 1,
      outcome: 'completed',
    }));
    expect(result.current.activeCompaction).toMatchObject({
      attemptId: recoveredAttemptId,
      compactionIndex: 1,
    });

    act(() => socket.message({
      type: 'compaction_finished',
      sequence: 4,
      occurredAt: startedAt,
      harnessRunId,
      attemptId: recoveredAttemptId,
      compactionIndex: 1,
      outcome: 'failed',
    }));
    expect(result.current.activeCompaction).toBeNull();
  });

  it('lets a reopened reader request base state from an already-connected room', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000625';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => result.current.requestSnapshot());

    expect(sentFrames(socket)).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
      { type: 'request_snapshot' },
    ]);
  });

  it('does not send a second subscribe when the signed upgrade bootstraps the feed', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000624';
    const getSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
      subscriptionBootstrap: true,
    }));
    const api = socketApiWith({ getSocketTicket });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    expect(socket.send).not.toHaveBeenCalled();
    expect(getSocketTicket).toHaveBeenCalledWith(
      workstreamId,
      '0',
      expect.any(String),
      0,
      false,
      expect.any(AbortSignal),
      WORKSTREAM_OPEN_TIMEOUT_BASE_MS,
    );
  });

  it('normalizes legacy suggested resources in snapshots and live frames without losing sequence', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000095';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });
    await flushPromises();
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.message(snapshotFrame({
      sequence: 1,
      workstream: { id: workstreamId, resources: [legacySuggestedResource()] },
    })));
    act(() => first.message({
      type: 'resource_attached',
      sequence: 2,
      occurredAt: '2026-07-31T19:20:01.000Z',
      resource: legacySuggestedResource({
        id: '00000000-0000-7000-8000-000000000097',
        title: 'Second accepted resource',
      }),
    }));
    act(() => first.message({
      type: 'resource_updated',
      sequence: 3,
      occurredAt: '2026-07-31T19:20:02.000Z',
      resource: legacySuggestedResource({ title: 'Updated accepted context' }),
    }));

    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId])?.resources)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'Updated accepted context', relationshipType: 'attachment' }),
        expect.objectContaining({ title: 'Second accepted resource', relationshipType: 'attachment' }),
      ]));

    act(() => first.close());
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    expect(second.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'subscribe',
      afterSequence: 3,
      publishPresence: false,
    }));
  });

  it('keeps a narrowed history prefix requestable and retains it across reconciliation', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000626';
    const firstSnapshotId = '00000000-0000-7000-8000-000000000727';
    const refreshedSnapshotId = '00000000-0000-7000-8000-000000000728';
    const latestTurn = transcriptTurn(25, 'latest');
    const historicalTurn = transcriptTurn(5, 'history the reader loaded');
    const openingTranscript = {
      ...emptyTranscriptSnapshot(),
      snapshotId: firstSnapshotId,
      snapshotThrough: 30,
      eventSequence: 1,
      ranges: [{
        purpose: 'latest' as const,
        requested: { startInclusive: 21, endExclusive: 31 },
        covered: { startInclusive: 21, endExclusive: 31 },
        turns: [latestTurn],
        activities: [],
        pluginRuns: [],
      }],
    };
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message(snapshotFrame({ sequence: 1, transcript: openingTranscript })));

    const rangePromise = result.current.loadTranscriptRange({
      snapshotId: firstSnapshotId,
      range: { startInclusive: 1, endExclusive: 21 },
      resumeAfterEventSequence: 1,
    });
    const rangeCommand = sentFrames(socket).at(-1) as {
      type: 'load_transcript_range'; requestId: string;
    };
    act(() => socket.message({
      type: 'transcript_range',
      sequence: 1,
      occurredAt: '2026-07-31T19:20:00.000Z',
      requestId: rangeCommand.requestId,
      snapshotId: firstSnapshotId,
      result: {
        purpose: 'requested',
        requested: { startInclusive: 1, endExclusive: 21 },
        covered: { startInclusive: 1, endExclusive: 8 },
        turns: [historicalTurn],
        activities: [],
        pluginRuns: [],
      },
    }));
    await expect(rangePromise).resolves.toMatchObject({
      requested: { startInclusive: 1, endExclusive: 21 },
      covered: { startInclusive: 1, endExclusive: 8 },
    });
    const partiallyLoaded = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', workstreamId],
    );
    expect(partiallyLoaded && transcriptGaps(partiallyLoaded)).toContainEqual({
      startInclusive: 8,
      endExclusive: 21,
    });

    act(() => result.current.requestSnapshot());
    act(() => socket.message(snapshotFrame({
      sequence: 1,
      reason: 'reconciliation',
      transcript: { ...openingTranscript, snapshotId: refreshedSnapshotId },
    })));

    const refreshed = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', workstreamId],
    );
    expect(refreshed?.snapshotId).toBe(refreshedSnapshotId);
    expect(refreshed?.ranges.flatMap((range) => range.turns).map((turn) => turn.transcriptSequence))
      .toEqual([5, 25]);
  });

  it('drops old-fence lifecycle turns when replay history is unavailable and reloads them under the new fence', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-00000000062a';
    const oldSnapshotId = '00000000-0000-7000-8000-00000000072a';
    const recoveredSnapshotId = '00000000-0000-7000-8000-00000000072b';
    const toolTurn = {
      ...transcriptTurn(5, ''),
      revision: 1,
      blocks: [{
        type: 'tool' as const,
        blockId: 'turn-5:tool:0',
        blockIndex: 0,
        toolCallId: 'call-old-fence',
        pluginId: 'github',
        toolName: 'Search',
        callIndex: 0,
        status: 'started' as const,
        participantSafeInput: null,
        participantSafeResult: null,
        error: null,
        activityId: 'activity-old-fence',
      }],
    };
    const staleActivity = {
      activityId: 'activity-old-fence', parentActivityId: null, scope: 'tool_call' as const,
      subjectId: 'call-old-fence', callIndex: 0, label: 'Search', state: 'active' as const,
      intervals: [], revision: 1,
    };
    queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', workstreamId],
      {
        ...emptyTranscriptSnapshot(),
        snapshotId: oldSnapshotId,
        snapshotThrough: 30,
        eventSequence: 1,
        ranges: [{
          purpose: 'requested',
          requested: { startInclusive: 1, endExclusive: 21 },
          covered: { startInclusive: 1, endExclusive: 21 },
          turns: [toolTurn],
          activities: [staleActivity],
          pluginRuns: [],
        }, {
          purpose: 'latest',
          requested: { startInclusive: 21, endExclusive: 31 },
          covered: { startInclusive: 21, endExclusive: 31 },
          turns: [transcriptTurn(25, 'latest')],
          activities: [],
          pluginRuns: [],
        }],
        activities: [staleActivity],
        activeActivities: [staleActivity],
      },
    );
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message(snapshotFrame({
      sequence: 2,
      reason: 'history_unavailable',
      workstream: { id: workstreamId },
      transcript: {
        ...emptyTranscriptSnapshot(),
        snapshotId: recoveredSnapshotId,
        snapshotThrough: 30,
        eventSequence: 2,
        ranges: [{
          purpose: 'latest',
          requested: { startInclusive: 21, endExclusive: 31 },
          covered: { startInclusive: 21, endExclusive: 31 },
          turns: [transcriptTurn(25, 'latest')],
          activities: [],
          pluginRuns: [],
        }],
      },
    })));

    const recovered = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', workstreamId],
    );
    expect(recovered?.snapshotId).toBe(recoveredSnapshotId);
    expect(recovered?.ranges.flatMap((range) => range.turns)
      .map((turn) => turn.transcriptSequence)).toEqual([25]);
    expect(recovered?.activities).toEqual([]);

    const rangePromise = result.current.loadTranscriptRange({
      snapshotId: recoveredSnapshotId,
      range: { startInclusive: 1, endExclusive: 21 },
      resumeAfterEventSequence: 2,
    });
    const rangeCommand = sentFrames(socket).at(-1) as {
      type: 'load_transcript_range'; requestId: string;
    };
    act(() => socket.message({
      type: 'transcript_range',
      sequence: 2,
      occurredAt: '2026-07-31T19:20:00.000Z',
      requestId: rangeCommand.requestId,
      snapshotId: recoveredSnapshotId,
      result: {
        purpose: 'requested',
        requested: { startInclusive: 1, endExclusive: 21 },
        covered: { startInclusive: 1, endExclusive: 21 },
        turns: [{
          ...toolTurn,
          revision: 2,
          blocks: [{ ...toolTurn.blocks[0]!, status: 'completed' as const }],
        }],
        activities: [{ ...staleActivity, state: 'completed' as const, revision: 2 }],
        pluginRuns: [],
      },
    }));
    await rangePromise;

    const reloaded = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', workstreamId],
    );
    expect(reloaded?.ranges.flatMap((range) => range.turns)
      .find((turn) => turn.turnId === toolTurn.turnId)?.blocks[0]).toMatchObject({
      type: 'tool', status: 'completed',
    });
    expect(reloaded?.activities.find((activity) => activity.activityId === staleActivity.activityId))
      .toMatchObject({ state: 'completed', revision: 2 });
  });

  it('rejects an in-flight range from a superseded snapshot instead of reporting a successful no-op', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000627';
    const firstSnapshotId = '00000000-0000-7000-8000-000000000729';
    const refreshedSnapshotId = '00000000-0000-7000-8000-000000000730';
    const openingTranscript = {
      ...emptyTranscriptSnapshot(),
      snapshotId: firstSnapshotId,
      snapshotThrough: 30,
      eventSequence: 1,
      ranges: [{
        purpose: 'latest' as const,
        requested: { startInclusive: 21, endExclusive: 31 },
        covered: { startInclusive: 21, endExclusive: 31 },
        turns: [transcriptTurn(25, 'latest')],
        activities: [],
        pluginRuns: [],
      }],
    };
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message(snapshotFrame({ sequence: 1, transcript: openingTranscript })));
    const settled = result.current.loadTranscriptRange({
      snapshotId: firstSnapshotId,
      range: { startInclusive: 1, endExclusive: 21 },
      resumeAfterEventSequence: 1,
    }).then(() => null, (error: unknown) => error);
    const rangeCommand = sentFrames(socket).at(-1) as {
      type: 'load_transcript_range'; requestId: string;
    };

    act(() => result.current.requestSnapshot());
    act(() => socket.message(snapshotFrame({
      sequence: 1,
      reason: 'reconciliation',
      transcript: { ...openingTranscript, snapshotId: refreshedSnapshotId },
    })));
    act(() => socket.message({
      type: 'transcript_range',
      sequence: 1,
      occurredAt: '2026-07-31T19:20:00.000Z',
      requestId: rangeCommand.requestId,
      snapshotId: firstSnapshotId,
      result: {
        purpose: 'requested',
        requested: { startInclusive: 1, endExclusive: 21 },
        covered: { startInclusive: 1, endExclusive: 21 },
        turns: [transcriptTurn(5, 'stale history')],
        activities: [],
        pluginRuns: [],
      },
    }));

    await expect(settled).resolves.toMatchObject({ code: 'transcript_snapshot_changed' });
    const current = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', workstreamId],
    );
    expect(current?.snapshotId).toBe(refreshedSnapshotId);
    expect(current?.ranges.flatMap((range) => range.turns).map((turn) => turn.transcriptSequence))
      .toEqual([25]);
  });

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
  });

  it('does not let stale transcript data reopen an answered elicitation', () => {
    const open: Message = {
      id: 'elicitation-question-one',
      workstreamId: 'workstream-one',
      sequenceNumber: 4,
      authorType: 'agent',
      messageType: 'elicitation',
      createdAt: '2026-07-31T19:20:00.000Z',
      elicitation: {
        id: 'question-one',
        prompt: 'Choose one',
        responseType: 'single_select',
        status: 'open',
      },
    };
    const answered: Message = {
      ...open,
      sequenceNumber: 5,
      authorType: 'human',
      elicitation: { ...open.elicitation!, status: 'answered', answer: 'foo' },
    };

    expect(insertMessage([answered], open)).toEqual([answered]);
    expect(insertMessage([open], answered)).toEqual([answered]);
  });

  it('joins an unseen active stream at its checkpoint and appends only new chunks', () => {
    const workstreamId = '00000000-0000-7000-8000-000000000071';
    const messageId = '00000000-0000-7000-8000-000000000072';
    const cursors = new Map();
    let transcript = applyActiveStreamCheckpoints([], [{
      streamId: messageId,
      harnessRunId: '00000000-0000-7000-8000-000000000073',
      turnId: 'turn-cold-join',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 2,
      seenTurnIds: ['turn-cold-join'],
      text: 'Already streamed',
      turnStartOffset: 0,
      roomSequence: 20,
      createdAt: '2026-07-31T19:20:00.000Z',
    }], workstreamId, cursors);

    expect(cursors.get('turn-cold-join')?.pacing).toBeUndefined();
    expect(cursors.get('turn-cold-join')?.lastRevealAt).toBeNull();

    // Catch-up may overlap the checkpoint when a frame lands during snapshot
    // loading. Its Bind cursor prevents the prefix being appended twice.
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 21,
      occurredAt: '2026-07-31T19:20:01.000Z',
      streamId: messageId,
      turnId: 'turn-cold-join',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 2,
      reset: false,
      delta: ' streamed',
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 22,
      occurredAt: '2026-07-31T19:20:02.000Z',
      streamId: messageId,
      turnId: 'turn-cold-join',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 3,
      reset: false,
      delta: ' and live',
    }, workstreamId, cursors);

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: 'turn-cold-join',
      text: 'Already streamed and live',
      streaming: true,
    });
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
      streamId: messageId,
      harnessRunId,
      turnId: 'turn-one',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 11,
      occurredAt: '2026-07-31T19:21:01.000Z',
      streamId: messageId,
      turnId: 'turn-one',
      transcriptSequence: 1,
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
      streamId: messageId,
      turnId: 'turn-one',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'Hel',
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 13,
      occurredAt: '2026-07-31T19:21:02.000Z',
      streamId: messageId,
      turnId: 'turn-one',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 2,
      reset: false,
      delta: 'lo',
    }, workstreamId, cursors);
    expect(transcript.find((message) => message.id === 'turn-one')?.text).toBe('Hello');

    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_started',
      sequence: 14,
      occurredAt: '2026-07-31T19:21:03.000Z',
      streamId: messageId,
      harnessRunId,
      turnId: 'turn-two',
      transcriptSequence: 2,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 15,
      occurredAt: '2026-07-31T19:21:04.000Z',
      streamId: messageId,
      turnId: 'turn-two',
      transcriptSequence: 2,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: ' discard this',
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 16,
      occurredAt: '2026-07-31T19:21:05.000Z',
      streamId: messageId,
      turnId: 'turn-two',
      transcriptSequence: 2,
      epoch: 1,
      streamSeq: 2,
      reset: true,
      delta: '',
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 17,
      occurredAt: '2026-07-31T19:21:06.000Z',
      streamId: messageId,
      turnId: 'turn-two',
      transcriptSequence: 2,
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
      streamId: messageId,
      turnId: 'turn-two',
      transcriptSequence: 2,
      epoch: 0,
      streamSeq: 99,
      reset: false,
      delta: ' stale',
    }, workstreamId, cursors);
    expect(transcript.find((message) => message.id === 'turn-one')?.text).toBe('Hello');
    expect(transcript.find((message) => message.id === 'turn-two')?.text).toBe(' world');
  });

  it('appends Bind post-tool turns without coalescing narration around tools', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const frames = stubAnimationFrames();
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000021';
    const harnessRunId = '00000000-0000-7000-8000-000000000051';
    const assistantMessageId = harnessRunId;
    const toolOneId = '00000000-0000-7000-8000-000000000052';
    const toolTwoId = '00000000-0000-7000-8000-000000000053';
    const getSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    act(() => FakeWebSocket.instances[0]?.open());
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'stream_started',
      sequence: 204,
      occurredAt: '2026-07-31T19:21:00.000Z',
      streamId: assistantMessageId,
      harnessRunId,
      turnId: 'turn-one',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'stream_delta',
      sequence: 205,
      occurredAt: '2026-07-31T19:21:00.500Z',
      streamId: assistantMessageId,
      turnId: 'turn-one',
      transcriptSequence: 1,
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
      streamId: assistantMessageId,
      harnessRunId,
      turnId: 'turn-two',
      transcriptSequence: 4,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'stream_delta',
      sequence: 211,
      occurredAt: '2026-07-31T19:21:06.750Z',
      streamId: assistantMessageId,
      turnId: 'turn-two',
      transcriptSequence: 4,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'Here is the result.',
    }));
    await frames.flush();

    expect(overlayMessages(queryClient, workstreamId)
      .filter((message) => message.id === 'turn-one' || message.id === 'turn-two')
      .map((message) => [message.id, message.text])).toEqual([
        ['turn-one', 'I will check. '],
        ['turn-two', 'Here is the result.'],
      ]);

    act(() => FakeWebSocket.instances[0]?.message({
      type: 'stream_completed',
      sequence: 212,
      occurredAt: '2026-07-31T19:21:07.000Z',
      streamId: assistantMessageId,
    }));
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'stream_delta',
      sequence: 213,
      occurredAt: '2026-07-31T19:21:08.000Z',
      streamId: assistantMessageId,
      turnId: 'turn-two',
      transcriptSequence: 4,
      epoch: 0,
      streamSeq: 2,
      reset: false,
      delta: 'This late chunk must be ignored.',
    }));

    const live = overlayMessages(queryClient, workstreamId);
    expect(live.map((message) => message.id)).toEqual([
      'turn-one',
      `tool-${toolOneId}`,
      `tool-${toolTwoId}`,
      'turn-two',
    ]);
    expect(live.filter((message) => message.messageType === 'text').map((message) => message.text))
      .toEqual(['I will check. ', 'Here is the result.']);
  });

  it.each([250, 2000, 10000])('paces a new packet after a drained %ims gap without bursting or crawling', async (gap) => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const frames = stubAnimationFrames();
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000701';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const deliver = (sequence: number) => act(() => socket.message({
      type: 'stream_delta', sequence, occurredAt: '2026-08-23T12:00:00.100Z',
      streamId: '00000000-0000-7000-8000-000000000702', turnId: 'turn-paced', transcriptSequence: 1,
      epoch: 0, streamSeq: sequence, reset: false, delta: 'abcdefghij',
    }));
    deliver(1);
    for (now = 17; now <= 119; now += 17) await frames.step(now);
    expect(overlayMessages(queryClient, workstreamId)[0]?.text).toBe('abcdefghij');
    // No frame is scheduled while drained. Deliver after the idle interval,
    // then exercise the first frame and the full next packet interval.
    now = gap;
    deliver(2);
    now += 17;
    await frames.step(now);
    const prefix = overlayMessages(queryClient, workstreamId)[0]?.text ?? '';
    expect(prefix.length).toBeGreaterThan(10);
    expect(prefix.length).toBeLessThan(20);
    for (now += 17; now <= gap + 119; now += 17) await frames.step(now);
    expect(overlayMessages(queryClient, workstreamId)[0]?.text).toBe('abcdefghijabcdefghij');
  });

  it('holds streamed text back and reveals it across animation frames', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const frames = stubAnimationFrames();
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000701';
    const messageId = '00000000-0000-7000-8000-000000000702';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'stream_started',
      sequence: 1,
      occurredAt: '2026-08-23T12:00:00.000Z',
      streamId: messageId,
      harnessRunId: '00000000-0000-7000-8000-000000000703',
      turnId: 'turn-paced',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => socket.message({
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-08-23T12:00:00.100Z',
      streamId: messageId,
      turnId: 'turn-paced',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'A burst of text held back by the paced reveal.',
    }));

    // The wire frame landed, and nothing of it is visible yet: the reveal
    // loop, not the socket event, is what grows the message.
    const held = overlayMessages(queryClient, workstreamId)[0];
    expect(held?.streaming).toBe(true);
    expect(held?.text).toBe('');
    act(() => socket.message({
      type: 'stream_completed',
      sequence: 3,
      occurredAt: '2026-08-23T12:00:00.200Z',
      streamId: messageId,
    }));
    expect(overlayMessages(queryClient, workstreamId)[0]).toMatchObject({
      text: 'A burst of text held back by the paced reveal.',
      streaming: false,
    });
    await frames.flush();
    expect(overlayMessages(queryClient, workstreamId)[0]?.text)
      .toBe('A burst of text held back by the paced reveal.');
  });

  it('clears failed partial output when the reserved canonical error turn arrives', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const frames = stubAnimationFrames();
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000706';
    const runId = '00000000-0000-7000-8000-000000000707';
    const turnId = 'reserved-failed-turn';
    queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', workstreamId],
      emptyTranscriptSnapshot(),
    );
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'stream_started',
      sequence: 1,
      occurredAt: '2026-08-23T12:00:00.000Z',
      streamId: runId,
      harnessRunId: runId,
      turnId,
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => socket.message({
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-08-23T12:00:00.100Z',
      streamId: runId,
      turnId,
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'observable partial',
    }));
    await frames.flush();
    expect(overlayMessages(queryClient, workstreamId)).toMatchObject([{
      text: 'observable partial',
      streaming: true,
    }]);

    act(() => socket.message({
      type: 'transcript_turn_upserted',
      sequence: 3,
      occurredAt: '2026-08-23T12:00:00.200Z',
      turn: {
        transcriptSequence: 1,
        turnId,
        entryKind: 'status',
        actor: 'system',
        authorUserId: null,
        authorSnapshot: null,
        attentionOrdinal: null,
        createdAtUtc: '2026-08-23T12:00:00.200Z',
        revision: 1,
        blocks: [{
          type: 'text',
          blockId: `${turnId}:status`,
          blockIndex: 0,
          text: 'Response could not be completed',
          streaming: false,
          messageType: 'system',
          structuredContent: { kind: 'assistant_turn_failed', code: 'provider_failed' },
        }],
        activityId: null,
      },
    }));
    act(() => socket.message({
      type: 'stream_completed',
      sequence: 4,
      occurredAt: '2026-08-23T12:00:00.300Z',
      streamId: runId,
    }));

    expect(overlayMessages(queryClient, workstreamId)).toEqual([]);
    const canonical = orderedTranscriptMessages(
      queryClient.getQueryData<WorkstreamTranscriptSnapshot>(['ordered-transcript', workstreamId]),
      workstreamId,
    );
    expect(canonical).toMatchObject([{
      transcriptTurnId: turnId,
      messageType: 'system',
      text: 'Response could not be completed',
      statusEvent: { kind: 'assistant_turn_failed', code: 'provider_failed' },
    }]);
    expect(canonical.map((message) => message.text)).not.toContain('observable partial');
  });

  it('does not mark a channel unread for the reader\'s own arriving turn', async () => {
    // The room advances the author's own read waterline in the write that
    // stores their message, so a client that guessed "unread" here would draw
    // an Unread messages divider above the turn the person just sent and light
    // their own sidebar dot for it, for as long as that state took to arrive.
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-00000000070a';
    const viewerUserId = '00000000-0000-7000-8000-00000000070b';
    queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', workstreamId],
      emptyTranscriptSnapshot(),
    );
    queryClient.setQueryData(
      ['workstream', workstreamId],
      workstreamDetail({ id: workstreamId, latestAttentionSequenceNumber: 4, readThroughSequenceNumber: 4 }),
    );
    setCachedWorkstreams(queryClient, [
      workstreamSummary({ id: workstreamId, latestAttentionSequenceNumber: 4, readThroughSequenceNumber: 4 }),
    ]);
    const api = socketApiWith({
      viewerUserId,
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'transcript_turn_upserted',
      sequence: 1,
      occurredAt: '2026-08-23T12:00:00.000Z',
      turn: {
        transcriptSequence: 1,
        turnId: 'own-turn',
        entryKind: 'conversation',
        actor: 'human',
        authorUserId: viewerUserId,
        authorSnapshot: { userId: viewerUserId, displayName: 'Adam', avatarUrl: null },
        attentionOrdinal: 5,
        createdAtUtc: '2026-08-23T12:00:00.000Z',
        revision: 1,
        blocks: [{
          type: 'text', blockId: 'own-turn:text:0', blockIndex: 0, text: 'noice', streaming: false,
        }],
        activityId: null,
      },
    }));
    await flushPromises();

    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId])).toMatchObject({
      latestAttentionSequenceNumber: 5,
      readThroughSequenceNumber: 5,
      hasUnread: false,
      firstUnreadSequenceNumber: null,
    });
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]).toMatchObject({
      hasUnread: false,
      firstUnreadSequenceNumber: null,
    });
  });

  it('clears the mention marker on the reader\'s own newest turn, and keeps a later one', async () => {
    // The room does not store `youAreMentioned`; it derives it as
    // `latest_mention_attention_ordinal > seen_attention_ordinal`, so advancing
    // the author's own seen ordinal past a mention clears it. Leaving it set
    // would trade one wrongly lit dot for a louder one: `mentioned` outranks
    // `unread` in the marker ranking. The fence is that the turn
    // is the newest attention event known, so a replay cannot erase a mention
    // that landed after it.
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const viewerUserId = '00000000-0000-7000-8000-00000000070b';
    const ownTurn = (turnId: string, attentionOrdinal: number) => ({
      type: 'transcript_turn_upserted' as const,
      sequence: 1,
      occurredAt: '2026-08-23T12:00:00.000Z',
      turn: {
        transcriptSequence: 1,
        turnId,
        entryKind: 'conversation' as const,
        actor: 'human' as const,
        authorUserId: viewerUserId,
        authorSnapshot: { userId: viewerUserId, displayName: 'Adam', avatarUrl: null },
        attentionOrdinal,
        createdAtUtc: '2026-08-23T12:00:00.000Z',
        revision: 1,
        blocks: [{
          type: 'text' as const, blockId: `${turnId}:text:0`, blockIndex: 0, text: 'on it', streaming: false,
        }],
        activityId: null,
      },
    });
    const openFeed = async (workstreamId: string, latestAttentionSequenceNumber: number) => {
      const queryClient = new QueryClient();
      queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
        ['ordered-transcript', workstreamId],
        emptyTranscriptSnapshot(),
      );
      queryClient.setQueryData(
        ['workstream', workstreamId],
        workstreamDetail({
          id: workstreamId,
          latestAttentionSequenceNumber,
          readThroughSequenceNumber: 4,
          youAreMentioned: true,
        }),
      );
      const api = socketApiWith({
        viewerUserId,
        getSocketTicket: vi.fn(async () => ({
          url: `wss://api.rally.test/workstreams/${workstreamId}`,
          ticket: 'socket-ticket',
          protocols: socketTicketProtocols('socket-ticket'),
        })),
      });
      renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
        wrapper: createWrapper(queryClient),
      });
      await flushPromises();
      return { queryClient, socket: FakeWebSocket.instances.at(-1)! };
    };

    // The reply is the newest thing this client knows about: the mention it
    // answers is behind it, and the room has cleared the flag.
    const newest = await openFeed('00000000-0000-7000-8000-00000000070f', 5);
    act(() => newest.socket.open());
    act(() => newest.socket.message(ownTurn('own-reply', 6)));
    await flushPromises();
    expect(queryDetail(newest.queryClient, '00000000-0000-7000-8000-00000000070f')).toMatchObject({
      readThroughSequenceNumber: 6,
      youAreMentioned: false,
    });

    // A mention already landed at 8. This turn is a replay from behind it and
    // must not speak for the room about a decision made after it.
    const stale = await openFeed('00000000-0000-7000-8000-000000000710', 8);
    act(() => stale.socket.open());
    act(() => stale.socket.message(ownTurn('own-replayed-reply', 6)));
    await flushPromises();
    expect(queryDetail(stale.queryClient, '00000000-0000-7000-8000-000000000710')).toMatchObject({
      readThroughSequenceNumber: 6,
      youAreMentioned: true,
    });
  });

  it('leaves a manual unread mark standing when the reader\'s own turn arrives', async () => {
    // The room clears the author's mark in the write that stores their turn,
    // but this runs on a frame that carries no ordering: `markUnread` records
    // `manual_unread_from_ordinal = latest`, which for a turn just sent is that
    // turn's own ordinal, so nothing here can tell a mark made before the write
    // from one made after it — on another device, or before a replay. Erasing a
    // newer decision is the worse failure, so the mark is left to the room.
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-00000000070e';
    const viewerUserId = '00000000-0000-7000-8000-00000000070b';
    queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', workstreamId],
      emptyTranscriptSnapshot(),
    );
    queryClient.setQueryData(
      ['workstream', workstreamId],
      workstreamDetail({
        id: workstreamId,
        latestAttentionSequenceNumber: 4,
        readThroughSequenceNumber: 4,
        manualUnreadFromSequenceNumber: 3,
        manualUnreadGeneration: 2,
      }),
    );
    const api = socketApiWith({
      viewerUserId,
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'transcript_turn_upserted',
      sequence: 1,
      occurredAt: '2026-08-23T12:00:00.000Z',
      turn: {
        transcriptSequence: 1,
        turnId: 'own-turn-after-mark',
        entryKind: 'conversation',
        actor: 'human',
        authorUserId: viewerUserId,
        authorSnapshot: { userId: viewerUserId, displayName: 'Adam', avatarUrl: null },
        attentionOrdinal: 5,
        createdAtUtc: '2026-08-23T12:00:00.000Z',
        revision: 1,
        blocks: [{
          type: 'text', blockId: 'own-turn-after-mark:text:0', blockIndex: 0, text: 'noice', streaming: false,
        }],
        activityId: null,
      },
    }));
    await flushPromises();

    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId])).toMatchObject({
      readThroughSequenceNumber: 5,
      manualUnreadFromSequenceNumber: 3,
      hasUnread: true,
      firstUnreadSequenceNumber: 3,
    });
  });

  it('marks a channel unread for a coworker\'s arriving turn', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-00000000070c';
    queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
      ['ordered-transcript', workstreamId],
      emptyTranscriptSnapshot(),
    );
    queryClient.setQueryData(
      ['workstream', workstreamId],
      workstreamDetail({ id: workstreamId, latestAttentionSequenceNumber: 4, readThroughSequenceNumber: 4 }),
    );
    const api = socketApiWith({
      viewerUserId: '00000000-0000-7000-8000-00000000070b',
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'transcript_turn_upserted',
      sequence: 1,
      occurredAt: '2026-08-23T12:00:00.000Z',
      turn: {
        transcriptSequence: 1,
        turnId: 'coworker-turn',
        entryKind: 'conversation',
        actor: 'human',
        authorUserId: '00000000-0000-7000-8000-00000000070d',
        authorSnapshot: {
          userId: '00000000-0000-7000-8000-00000000070d', displayName: 'Sam', avatarUrl: null,
        },
        attentionOrdinal: 5,
        createdAtUtc: '2026-08-23T12:00:00.000Z',
        revision: 1,
        blocks: [{
          type: 'text', blockId: 'coworker-turn:text:0', blockIndex: 0, text: 'take a look', streaming: false,
        }],
        activityId: null,
      },
    }));
    await flushPromises();

    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId])).toMatchObject({
      readThroughSequenceNumber: 4,
      hasUnread: true,
      firstUnreadSequenceNumber: 5,
    });
  });

  it('ignores completion for an older stream without closing the active stream', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const frames = stubAnimationFrames();
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000704';
    const oldStreamId = '00000000-0000-7000-8000-000000000714';
    const activeStreamId = '00000000-0000-7000-8000-000000000715';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const start = (
      sequence: number,
      streamId: string,
      turnId: string,
      transcriptSequence: number,
    ) => socket.message({
      type: 'stream_started', sequence, occurredAt: '2026-08-23T12:00:00.000Z',
      streamId, harnessRunId: streamId, turnId, transcriptSequence,
      epoch: 0, streamSeq: 0, reset: false,
    });
    act(() => start(1, oldStreamId, 'turn-old', 1));
    act(() => start(2, activeStreamId, 'turn-active', 2));
    act(() => socket.message({
      type: 'stream_delta', sequence: 3, occurredAt: '2026-08-23T12:00:00.100Z',
      streamId: activeStreamId, turnId: 'turn-active', transcriptSequence: 2,
      epoch: 0, streamSeq: 1,
      reset: false, delta: 'still running',
    }));
    act(() => socket.message({
      type: 'stream_completed', sequence: 4, occurredAt: '2026-08-23T12:00:00.200Z',
      streamId: oldStreamId,
    }));
    act(() => socket.message({
      type: 'stream_delta', sequence: 5, occurredAt: '2026-08-23T12:00:00.300Z',
      streamId: activeStreamId, turnId: 'turn-active', transcriptSequence: 2,
      epoch: 0, streamSeq: 2,
      reset: false, delta: ' after stale completion',
    }));
    await frames.flush();

    expect(overlayMessages(queryClient, workstreamId).find((message) => message.id === 'turn-active'))
      .toMatchObject({ text: 'still running after stale completion', streaming: true });
  });

  it('does not let a requested snapshot roll back a newer canonical transcript event', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    stubAnimationFrames();
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000705';
    const current = { ...emptyTranscriptSnapshot(), snapshotThrough: 4, eventSequence: 9 };
    queryClient.setQueryData(['ordered-transcript', workstreamId], current);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message(snapshotFrame({
      sequence: 10,
      transcript: { ...emptyTranscriptSnapshot(), snapshotThrough: 3, eventSequence: 8 },
    })));

    expect(queryClient.getQueryData(['ordered-transcript', workstreamId])).toBe(current);
  });

  it('reveals streamed text immediately while the document is hidden', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    stubAnimationFrames();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000711';
    const messageId = '00000000-0000-7000-8000-000000000712';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    try {
      await flushPromises();
      const socket = FakeWebSocket.instances[0]!;
      act(() => socket.open());
      act(() => socket.message({
        type: 'stream_started',
        sequence: 1,
        occurredAt: '2026-08-23T12:00:00.000Z',
        streamId: messageId,
        harnessRunId: '00000000-0000-7000-8000-000000000713',
        turnId: 'turn-hidden',
        transcriptSequence: 1,
        epoch: 0,
        streamSeq: 0,
        reset: false,
      }));
      act(() => socket.message({
        type: 'stream_delta',
        sequence: 2,
        occurredAt: '2026-08-23T12:00:00.100Z',
        streamId: messageId,
        turnId: 'turn-hidden',
        transcriptSequence: 1,
        epoch: 0,
        streamSeq: 1,
        reset: false,
        delta: 'Shown at once — no animation frames fire in a hidden window.',
      }));

      expect(overlayMessages(queryClient, workstreamId)[0]?.text)
        .toBe('Shown at once — no animation frames fire in a hidden window.');
    } finally {
      visibility.mockRestore();
    }
  });

  it('flushes an inherited reveal backlog when it mounts in a hidden window', async () => {
    // A remount can inherit cursors holding unrevealed text through the resume
    // registry — and a hidden window gets no animation frames, so an armed
    // loop would never fire. Hidden means nobody is watching: show it at once.
    vi.stubGlobal('WebSocket', FakeWebSocket);
    stubAnimationFrames(); // queued but never flushed: no frame ever fires
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000731';
    const messageId = '00000000-0000-7000-8000-000000000732';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    function Socket(): null {
      useWorkstreamSocket(api, workstreamId, true);
      return null;
    }
    function Tree({ mounted }: { mounted: boolean }): React.JSX.Element {
      return (
        <QueryClientProvider client={queryClient}>
          <WorkstreamSocketResumeProvider scope="user-one:workspace-one">
            {mounted ? <Socket /> : null}
          </WorkstreamSocketResumeProvider>
        </QueryClientProvider>
      );
    }
    const rendered = render(<Tree mounted />);
    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'stream_started',
      sequence: 1,
      occurredAt: '2026-08-23T12:00:00.000Z',
      streamId: messageId,
      harnessRunId: '00000000-0000-7000-8000-000000000733',
      turnId: 'turn-inherited',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => socket.message({
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-08-23T12:00:00.100Z',
      streamId: messageId,
      turnId: 'turn-inherited',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'Held back across the remount.',
    }));
    expect(overlayMessages(queryClient, workstreamId)[0]?.text).toBe('');

    rendered.rerender(<Tree mounted={false} />);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      rendered.rerender(<Tree mounted />);
      await flushPromises();
      expect(overlayMessages(queryClient, workstreamId)[0]?.text)
        .toBe('Held back across the remount.');
    } finally {
      visibility.mockRestore();
    }
  });

  it('drops text a retry retracted from the reveal instead of animating it away', () => {
    const workstreamId = '00000000-0000-7000-8000-000000000721';
    const messageId = '00000000-0000-7000-8000-000000000722';
    const cursors = new Map();
    let transcript = applyStreamingSocketEvent([], {
      type: 'stream_delta',
      sequence: 1,
      occurredAt: '2026-08-23T12:00:00.000Z',
      streamId: messageId,
      turnId: 'turn-retry',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'The first attempt, mostly unrevealed.',
    }, workstreamId, cursors, { paced: true });
    // Partially reveal the first attempt, then let a reset replace it.
    cursors.get('turn-retry')!.revealed = 9;
    cursors.get('turn-retry')!.lastRevealAt = 123;
    cursors.get('turn-retry')!.pacing.credit = 0.75;
    cursors.get('turn-retry')!.pacing.cadenceMs = 400;
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-08-23T12:00:00.500Z',
      streamId: messageId,
      turnId: 'turn-retry',
      transcriptSequence: 1,
      epoch: 1,
      streamSeq: 2,
      reset: true,
      delta: 'A fresh attempt.',
    }, workstreamId, cursors, { paced: true });

    // The retracted text disappears at once — the reveal clamps back to the
    // turn's start — and the replacement paces in from there.
    expect(transcript.find((message) => message.id === 'turn-retry')?.text).toBe('');
    expect(cursors.get('turn-retry')).toMatchObject({
      receivedText: 'A fresh attempt.',
      revealed: 0,
      lastRevealAt: null,
      pacing: { credit: 0, cadenceMs: 100, drawRate: 'A fresh attempt.'.length / 100 },
    });
  });

  it('does not rewrite the overlay cache for a paced wire delta that reveals no new text', () => {
    const workstreamId = '00000000-0000-7000-8000-000000000723';
    const streamId = '00000000-0000-7000-8000-000000000724';
    const cursors = new Map();
    const started = applyStreamingOverlayEvent([], {
      type: 'stream_started',
      sequence: 1,
      occurredAt: '2026-08-23T12:00:00.000Z',
      streamId,
      harnessRunId: streamId,
      turnId: 'turn-paced-cache',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }, workstreamId, 0, cursors, { paced: true });

    const held = applyStreamingOverlayEvent(started, {
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-08-23T12:00:00.100Z',
      streamId,
      turnId: 'turn-paced-cache',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'held for the reveal frame',
    }, workstreamId, 0, cursors, { paced: true });

    expect(held).toBe(started);
    expect(cursors.get('turn-paced-cache')).toMatchObject({
      receivedText: 'held for the reveal frame',
      revealed: 0,
    });
  });

  it('retains per-epoch stream cursors across a socket reconnect', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const frames = stubAnimationFrames();
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000061';
    const messageId = '00000000-0000-7000-8000-000000000062';
    const harnessRunId = '00000000-0000-7000-8000-000000000063';
    queryClient.setQueryData(['workstream', workstreamId], workstreamDetail({ id: workstreamId }));
    queryClient.setQueryData(['ordered-transcript', workstreamId], emptyTranscriptSnapshot());
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.message({
      type: 'stream_started',
      sequence: 1,
      occurredAt: '2026-07-31T19:21:00.000Z',
      streamId: messageId,
      harnessRunId,
      turnId: 'turn-reconnect',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => first.message({
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-07-31T19:21:01.000Z',
      streamId: messageId,
      turnId: 'turn-reconnect',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'One',
    }));
    act(() => first.close());
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    expect(second.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 2, publishPresence: false }));

    act(() => second.message({
      type: 'stream_delta',
      sequence: 3,
      occurredAt: '2026-07-31T19:21:02.000Z',
      streamId: messageId,
      turnId: 'turn-reconnect',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'One',
    }));
    act(() => second.message({
      type: 'stream_delta',
      sequence: 4,
      occurredAt: '2026-07-31T19:21:03.000Z',
      streamId: messageId,
      turnId: 'turn-reconnect',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 2,
      reset: false,
      delta: ' two',
    }));
    await frames.flush();
    expect(overlayMessages(queryClient, workstreamId)[0]?.text).toBe('One two');
  });

  it('shows the name Rally gives a channel in its header and its sidebar row', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000401';
    const provisional = 'Create an email draft to Danny from Mucker that shares the rally download link';
    queryClient.setQueryData(['workstream', workstreamId], {
      id: workstreamId,
      title: provisional,
      titleStatus: 'naming',
      harnessStatus: 'running',
    } as WorkstreamDetail);
    setCachedWorkstreams(queryClient, [
      { id: workstreamId, title: provisional, titleStatus: 'naming' },
      { id: '00000000-0000-7000-8000-000000000402', title: 'August planning', titleStatus: 'settled' },
    ] as WorkstreamSummary[]);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'workstream_renamed',
      sequence: 1,
      occurredAt: '2026-08-11T09:00:01.000Z',
      title: 'Rally download link email to Danny',
      titleStatus: 'automatic',
      icon: 'megaphone',
    }));

    // The event settles the skeleton as well as the text: `automatic` is a
    // name, just one a later pass may still improve on. The icon a naming pass
    // chose goes to the sidebar row with it.
    //
    // It must NOT go to the cached detail, which is the entry the appearance
    // picker reads to decide its own preview is done: `settled()` retires a
    // pending choice as soon as the detail's icon moves off the baseline it was
    // taken against, to any value at all, because another person changing the
    // icon has to retire it too. Writing a generated icon there while somebody's
    // own choice is still in flight would retire theirs to this one and hold the
    // header on it until the projection lands. Only the versioned projection may
    // move the detail.
    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId]))
      .toMatchObject({ title: 'Rally download link email to Danny', titleStatus: 'automatic' });
    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId]))
      .not.toHaveProperty('appearance');
    expect(queryClient.getQueryData<WorkstreamSummary[]>(['workstreams'])).toEqual([
      {
        id: workstreamId,
        title: 'Rally download link email to Danny',
        titleStatus: 'automatic',
        appearance: { icon: 'megaphone', color: null },
      },
      { id: '00000000-0000-7000-8000-000000000402', title: 'August planning', titleStatus: 'settled' },
    ]);
  });

  it('keeps a child rename out of the parent sidebar row', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000401';
    const provisional = 'Create an email draft to Danny from Mucker that shares the rally download link';
    queryClient.setQueryData(['substream-workstream', workstreamId, 'child'], {
      id: workstreamId,
      title: provisional,
      titleStatus: 'naming',
      harnessStatus: 'running',
    } as WorkstreamDetail);
    setCachedWorkstreams(queryClient, [
      { id: workstreamId, title: provisional, titleStatus: 'naming' },
      { id: '00000000-0000-7000-8000-000000000402', title: 'August planning', titleStatus: 'settled' },
    ] as WorkstreamSummary[]);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true, 'active_workstream', undefined, true, 'child'), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'workstream_renamed',
      sequence: 1,
      occurredAt: '2026-08-11T09:00:01.000Z',
      title: 'Rally download link email to Danny',
      titleStatus: 'automatic',
      icon: 'megaphone',
    }));

    // The event settles the skeleton as well as the text: `automatic` is a
    // name, just one a later pass may still improve on.
    expect(queryClient.getQueryData<WorkstreamDetail>(['substream-workstream', workstreamId, 'child']))
      .toMatchObject({ title: 'Rally download link email to Danny', titleStatus: 'automatic' });
    expect(queryClient.getQueryData<WorkstreamSummary[]>(['workstreams'])).toEqual([
      { id: workstreamId, title: provisional, titleStatus: 'naming' },
      { id: '00000000-0000-7000-8000-000000000402', title: 'August planning', titleStatus: 'settled' },
    ]);
  });

  it('leaves an icon a person already chose alone when a naming event arrives after it', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000409';
    queryClient.setQueryData(['workstream', workstreamId], {
      id: workstreamId,
      title: 'Mucker invoices',
      titleStatus: 'naming',
      harnessStatus: 'running',
    } as WorkstreamDetail);
    // Their own choice, already acknowledged and written to the row by the
    // receipt handler. The naming event was published before that command
    // committed, so the icon it carries is older than what is here.
    setCachedWorkstreams(queryClient, [
      { id: workstreamId, title: 'Mucker invoices', titleStatus: 'naming', appearance: { icon: 'rocket', color: 'teal' } },
    ] as WorkstreamSummary[]);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'workstream_renamed',
      sequence: 1,
      occurredAt: '2026-08-11T09:00:01.000Z',
      title: 'Reconcile Mucker invoices',
      titleStatus: 'automatic',
      icon: 'megaphone',
    }));

    // The name lands; the icon does not. The event carries an icon only when
    // the object had none when it renamed, so a row that has one holds
    // something newer — and the two travel different paths, so the event can
    // arrive after the receipt that put it there.
    expect(queryClient.getQueryData<WorkstreamSummary[]>(['workstreams'])).toEqual([
      {
        id: workstreamId,
        title: 'Reconcile Mucker invoices',
        titleStatus: 'automatic',
        appearance: { icon: 'rocket', color: 'teal' },
      },
    ]);
  });

  it('carries a visibility change to the header and the sidebar row', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000403';
    queryClient.setQueryData(['workstream', workstreamId], {
      id: workstreamId,
      title: 'Compensation review',
      scope: 'workspace',
      harnessStatus: 'completed',
    } as WorkstreamDetail);
    setCachedWorkstreams(queryClient, [
      { id: workstreamId, title: 'Compensation review', scope: 'workspace' },
      { id: '00000000-0000-7000-8000-000000000404', title: 'August planning', scope: 'workspace' },
    ] as WorkstreamSummary[]);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'workstream_scope_changed',
      sequence: 1,
      occurredAt: '2026-08-11T09:00:01.000Z',
      scope: 'personal',
    }));

    // Anyone the change excluded has been disconnected by the room, so everyone
    // who receives this may still read it and only needs the lock to appear.
    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId]))
      .toMatchObject({ title: 'Compensation review', scope: 'personal' });
    expect(queryClient.getQueryData<WorkstreamSummary[]>(['workstreams'])).toEqual([
      { id: workstreamId, title: 'Compensation review', scope: 'personal' },
      { id: '00000000-0000-7000-8000-000000000404', title: 'August planning', scope: 'workspace' },
    ]);
  });

  it('stops dialling a channel it has just been shut out of', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-7000-7000-8000-000000000405';
    queryClient.setQueryData(['workstream', workstreamId], {
      id: workstreamId,
      title: 'Compensation review',
      scope: 'workspace',
      harnessStatus: 'completed',
    } as WorkstreamDetail);
    queryClient.setQueryData(['ordered-transcript', workstreamId], { snapshotId: 'sensitive' });
    queryClient.setQueryData(transcriptOverlaysQueryKey(workstreamId), [{ sensitive: true }]);
    queryClient.setQueryData(workstreamFeedSourceQueryKey(workstreamId), 'socket_snapshot');
    queryClient.setQueryData(workstreamSocketSnapshotGenerationQueryKey(workstreamId), 1);
    setCachedWorkstreams(queryClient, [
      { id: workstreamId, title: 'Compensation review' },
      { id: '00000000-7000-7000-8000-000000000406', title: 'August planning' },
    ] as WorkstreamSummary[]);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(api.getSocketTicket).toHaveBeenCalledTimes(1);

    // Somebody else made this work stream private without them, and the room
    // closed the socket rather than sending them anything more.
    act(() => socket.close(1008));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(90_000);

    // The ticket behind a reconnect now answers 404, so retrying is a loop that
    // never ends. Nothing dialled again, and the transcript the reader may no
    // longer see is gone rather than left on screen.
    expect(api.getSocketTicket).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(queryClient.getQueryData(['workstream', workstreamId])).toBeUndefined();
    expect(queryClient.getQueryData(['ordered-transcript', workstreamId])).toBeUndefined();
    expect(queryClient.getQueryData(transcriptOverlaysQueryKey(workstreamId))).toBeUndefined();
    expect(queryClient.getQueryData(workstreamFeedSourceQueryKey(workstreamId))).toBeUndefined();
    expect(queryClient.getQueryData(workstreamSocketSnapshotGenerationQueryKey(workstreamId))).toBeUndefined();
    expect(queryClient.getQueryData<WorkstreamSummary[]>(['workstreams'])).toEqual([
      { id: '00000000-7000-7000-8000-000000000406', title: 'August planning' },
    ]);
  });

  it('still reconnects after an ordinary close', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-7000-7000-8000-000000000407';
    const getSocketTicket = vi.fn(async (id: string, substreamId?: string, requestId?: string) => {
      void id;
      void substreamId;
      void requestId;
      return {
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      };
    });
    const api = socketApiWith({ getSocketTicket });
    const openAttemptId = markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold', 0);
    renderHook(
      () => useWorkstreamSocket(api, workstreamId, true, 'background_workstream'),
      { wrapper: createWrapper(queryClient) },
    );

    await flushPromises();
    act(() => {
      FakeWebSocket.instances[0]!.open();
      FakeWebSocket.instances[0]!.message(snapshotFrame({
        sequence: 1,
        workstream: { id: workstreamId },
      }));
    });
    act(() => FakeWebSocket.instances[0]!.close());
    await vi.advanceTimersByTimeAsync(750);
    await flushPromises();

    // The revoked case must not have turned every close into a dead end.
    expect(api.getSocketTicket).toHaveBeenCalledTimes(2);
    const started = socketStartedTelemetry();
    expect(new Set(started.map((intent) => intent['socketLeaseId']))).toHaveLength(1);
    expect(started[0]?.['socketLeaseId']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(started.map(({ operationId, ...intent }) => {
      expect(operationId).toMatch(/^[0-9a-f-]{36}$/u);
      delete intent['socketLeaseId'];
      return intent;
    })).toEqual([
      {
        kind: 'workstream_socket_started', workstreamId, socket: 'substream_feed',
        openAttemptId, reason: 'background_workstream', attempts: 'zero',
      },
      {
        kind: 'workstream_socket_started', workstreamId, socket: 'substream_feed',
        openAttemptId, reason: 'reconnect', attempts: 'one',
      },
    ]);
    expect(getSocketTicket.mock.calls.map((call) => call[2]))
      .toEqual(started.map((intent) => intent['operationId']));
    cancelWorkstreamFeedOpen(workstreamId, 100);
  });

  it('refreshes run metadata when a new run starts in another client', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000099';
    const runId = '00000000-0000-7000-8000-0000000000a1';
    const latestHarnessRun = {
      id: runId,
      origin: 'message',
      status: 'running' as const,
      model: null,
      error: null,
      requestId: null,
      startedAt: '2026-08-06T05:00:00.000Z',
      completedAt: null,
      createdAt: '2026-08-06T05:00:00.000Z',
    };
    const cachedSummary = workstreamSummary({ id: workstreamId, harnessStatus: 'completed' });
    setCachedWorkstreams(queryClient, [cachedSummary]);
    queryClient.setQueryData(['workstream', workstreamId], {
      id: workstreamId,
      harnessStatus: 'completed',
      scope: 'workspace',
      latestHarnessRunId: 'run-old',
    });
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'harness_status_changed',
      sequence: 1,
      occurredAt: '2026-08-06T05:00:00.000Z',
      status: 'running',
    }));
    await flushPromises();

    // The status frame says the run changed; it does not carry the run. The
    // client asks the room for canonical state over the socket it already
    // holds rather than spending two REST reads on it.
    expect(sentFrames(socket)).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
      { type: 'request_snapshot' },
    ]);
    act(() => socket.message(snapshotFrame({
      sequence: 2,
      reason: 'reconciliation',
      workstream: {
        id: workstreamId,
        harnessStatus: 'running',
        latestHarnessRunId: runId,
        latestHarnessRun,
      },
    })));
    await flushPromises();

    // The renderer's shape, not the wire's: the mapper drops the null-valued
    // optional fields, and expecting the frame back would assert nothing about it.
    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId])?.latestHarnessRun).toEqual({
      id: runId,
      origin: 'message',
      status: 'running',
      startedAt: '2026-08-06T05:00:00.000Z',
      createdAt: '2026-08-06T05:00:00.000Z',
    });
    // Cross-workstream serving belongs to the WorkspaceDO socket. A substream
    // recovery patches this row and leaves the list to that socket: it neither
    // merges a parallel REST list nor walks every Space again.
    expect(queryClient.getQueryData<WorkstreamSummary[]>(['workstreams'])).toEqual([{
      ...cachedSummary,
      harnessStatus: 'running',
    }]);
    expect(queryClient.getQueryState(['workstreams'])?.isInvalidated).toBe(false);
  });

  it('pushes a status change into the sidebar list without waiting for a refetch', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000110';
    const otherWorkstreamId = '00000000-0000-7000-8000-000000000111';
    queryClient.setQueryData(['workstream', workstreamId], {
      id: workstreamId,
      harnessStatus: 'running',
    });
    setCachedWorkstreams(queryClient, [
      workstreamSummary({ id: workstreamId, harnessStatus: 'running' }),
      workstreamSummary({ id: otherWorkstreamId, harnessStatus: 'running' }),
    ]);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'harness_status_changed',
      sequence: 1,
      occurredAt: '2026-08-06T05:00:00.000Z',
      status: 'needs_input',
    }));

    // Asserted before the canonical reconciliation resolves: the frame itself
    // has to move both views, or the sidebar dot lags the header by a round trip.
    const summaries = queryClient.getQueryData<WorkstreamSummary[]>(['workstreams']);
    expect(summaries?.find((item) => item.id === workstreamId)?.harnessStatus).toBe('needs_input');
    expect(summaries?.find((item) => item.id === otherWorkstreamId)?.harnessStatus).toBe('running');
    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId])?.harnessStatus).toBe('needs_input');
    expect(queryClient.getQueryState(['workstreams'])?.isInvalidated).toBe(false);
    await flushPromises();
  });

  it('does not re-ask for a snapshot as a run streams under it', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000121';
    const messageId = '00000000-0000-7000-8000-000000000122';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'harness_status_changed',
      sequence: 1,
      occurredAt: '2026-07-31T19:20:00.000Z',
      status: 'running',
    }));

    // A run emits one of these per coalesced token batch. They advance the room
    // sequence and carry no canonical state, which is exactly the combination
    // that used to be read as "canonical state moved while I was asking" and
    // restart the reconciliation — once per batch, for the length of the run.
    for (let streamSeq = 1; streamSeq <= 25; streamSeq += 1) {
      act(() => socket.message({
        type: 'stream_delta',
        sequence: 1 + streamSeq,
        occurredAt: '2026-07-31T19:20:01.000Z',
        streamId: messageId,
        turnId: 'turn-one',
        transcriptSequence: 1,
        epoch: 0,
        streamSeq,
        reset: false,
        delta: 'token ',
      }));
    }
    // A second reason to reconcile, arriving before the first was answered.
    // One outstanding request covers both: the answer is assembled after both
    // frames, so a second request could only ask for the same state.
    act(() => socket.message({
      type: 'harness_status_changed',
      sequence: 27,
      occurredAt: '2026-07-31T19:20:04.000Z',
      status: 'needs_input',
    }));
    await flushPromises();

    expect(sentFrames(socket)).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
      { type: 'request_snapshot' },
    ]);

    // The answer releases the slot, and the run going terminal is a new reason
    // to ask — so coalescing suppresses repetition without suppressing the
    // reconciliation that matters.
    act(() => socket.message(snapshotFrame({
      sequence: 28,
      reason: 'reconciliation',
      workstream: { id: workstreamId, harnessStatus: 'running' },
    })));
    act(() => socket.message({
      type: 'harness_status_changed',
      sequence: 29,
      occurredAt: '2026-07-31T19:20:05.000Z',
      status: 'completed',
    }));
    await flushPromises();

    expect(sentFrames(socket)).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
      { type: 'request_snapshot' },
      { type: 'request_snapshot' },
    ]);
  });

  it('can reconcile again after the room refuses a snapshot request', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000131';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'harness_status_changed',
      sequence: 5,
      occurredAt: '2026-07-31T19:20:00.000Z',
      status: 'running',
    }));

    // The room can fail to assemble canonical state. Its error frame carries the
    // room's current sequence, so the ordinary ordering guard discards it — but
    // it is still the answer to the request, and a slot left open here would
    // suppress every later reconciliation for the life of the socket.
    act(() => socket.message({
      type: 'error',
      sequence: 5,
      occurredAt: '2026-07-31T19:20:01.000Z',
      code: 'snapshot_unavailable',
      message: 'Canonical channel state is unavailable.',
    }));
    act(() => socket.message({
      type: 'harness_status_changed',
      sequence: 6,
      occurredAt: '2026-07-31T19:20:02.000Z',
      status: 'completed',
    }));
    await flushPromises();

    expect(sentFrames(socket)).toEqual([
      { type: 'subscribe', afterSequence: 0, publishPresence: false },
      { type: 'request_snapshot' },
      { type: 'request_snapshot' },
    ]);
  });

  it('separates the wait for a socket into scheduling and handshake', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000141';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.handshakePhase('tls', 24.6));
    act(() => socket.open());
    act(() => socket.message(snapshotFrame({ sequence: 1, workstream: { id: workstreamId } })));
    await flushPromises();

    const line = debug.mock.calls
      .filter((call) => String(call[0]).startsWith('[perf]'))
      .map((call) => call[1] as {
        phases: Record<string, number>;
        sinceEffectMs: number;
        tlsMs?: number;
      })
      .at(-1)!;
    // `dial` closes on the line that constructs the WebSocket and `handshake`
    // on its open event. Collapsing them back into one number is what made a
    // blocked renderer indistinguishable from a slow connection.
    expect(Object.keys(line.phases)).toEqual(['socket_ticket', 'dial', 'handshake', 'first_frame']);
    expect(line.tlsMs).toBe(24.6);
    // Dead time before the first request, which the trace cannot cover: it does
    // not exist until `connect` runs.
    expect(line.sinceEffectMs).toEqual(expect.any(Number));
  });

  it('resets the replay sequence when the selected workstream changes', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const getSocketTicket = vi.fn(async (workstreamId: string) => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    const { rerender } = renderHook(
      ({ workstreamId }) => useWorkstreamSocket(api, workstreamId, true),
      { initialProps: { workstreamId: 'workstream-one' }, wrapper: createWrapper() },
    );

    await flushPromises();
    act(() => FakeWebSocket.instances[0]?.open());
    expect(FakeWebSocket.instances[0]?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 0, publishPresence: false }));

    act(() => FakeWebSocket.instances[0]?.message({
      type: 'harness_status_changed',
      sequence: 9,
      occurredAt: '2026-07-31T20:00:00.000Z',
      status: 'running',
    }));
    rerender({ workstreamId: 'workstream-two' });
    await flushPromises();
    act(() => FakeWebSocket.instances[1]?.open());

    expect(FakeWebSocket.instances[1]?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 0, publishPresence: false }));
  });

  it('hands a running stream between foreground and background subscribers without gaps or duplicate text', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const frames = stubAnimationFrames();
    const queryClient = new QueryClient();
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000401';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000402';
    const messageId = '00000000-0000-7000-8000-000000000403';
    const harnessRunId = '00000000-0000-7000-8000-000000000404';
    for (const workstreamId of [firstWorkstreamId, secondWorkstreamId]) {
      queryClient.setQueryData(['workstream', workstreamId], workstreamDetail({ id: workstreamId }));
      queryClient.setQueryData(['ordered-transcript', workstreamId], emptyTranscriptSnapshot());
    }
    const api = socketApiWith({
      getSocketTicket: vi.fn(async (workstreamId: string) => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });

    function Socket({ workstreamId }: { workstreamId: string }): null {
      useWorkstreamSocket(api, workstreamId, true);
      return null;
    }
    function Tree({ view }: { view: 'first' | 'away' | 'returned' }): React.JSX.Element {
      return (
        <QueryClientProvider client={queryClient}>
          <WorkstreamSocketResumeProvider scope="user-one:workspace-one">
            {view === 'away' ? (
              <>
                <Socket key="background-first" workstreamId={firstWorkstreamId} />
                <Socket key="foreground-second" workstreamId={secondWorkstreamId} />
              </>
            ) : (
              <Socket key={view} workstreamId={firstWorkstreamId} />
            )}
          </WorkstreamSocketResumeProvider>
        </QueryClientProvider>
      );
    }
    const latestSocketFor = (workstreamId: string): FakeWebSocket => {
      const socket = FakeWebSocket.instances.filter((candidate) => candidate.url.endsWith(workstreamId)).at(-1);
      if (!socket) throw new Error(`No socket for ${workstreamId}`);
      return socket;
    };

    const rendered = render(<Tree view="first" />);
    await flushPromises();
    const firstSocket = latestSocketFor(firstWorkstreamId);
    act(() => firstSocket.open());
    expect(firstSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 0, publishPresence: false }));
    act(() => firstSocket.message({
      type: 'stream_started',
      sequence: 1,
      occurredAt: '2026-07-31T19:21:00.000Z',
      streamId: messageId,
      harnessRunId,
      turnId: 'turn-route-change',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => firstSocket.message({
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-07-31T19:21:01.000Z',
      streamId: messageId,
      turnId: 'turn-route-change',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'One',
    }));

    rendered.rerender(<Tree view="away" />);
    await flushPromises();
    const backgroundSocket = latestSocketFor(firstWorkstreamId);
    act(() => backgroundSocket.open());
    expect(backgroundSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 2, publishPresence: false }));
    // A retried Bind frame can occupy a new room sequence. The stream cursor
    // crossing the component handoff must reject it before the next real chunk.
    act(() => backgroundSocket.message({
      type: 'stream_delta',
      sequence: 3,
      occurredAt: '2026-07-31T19:21:02.000Z',
      streamId: messageId,
      turnId: 'turn-route-change',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'One',
    }));
    act(() => backgroundSocket.message({
      type: 'stream_delta',
      sequence: 4,
      occurredAt: '2026-07-31T19:21:03.000Z',
      streamId: messageId,
      turnId: 'turn-route-change',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 2,
      reset: false,
      delta: ' two',
    }));
    await flushPromises();
    await frames.flush();
    expect(overlayMessages(queryClient, firstWorkstreamId)[0]?.text).toBe('One two');

    rendered.rerender(<Tree view="returned" />);
    await flushPromises();
    const returnedSocket = latestSocketFor(firstWorkstreamId);
    act(() => returnedSocket.open());
    expect(returnedSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 4, publishPresence: false }));
    act(() => returnedSocket.message({
      type: 'stream_delta',
      sequence: 5,
      occurredAt: '2026-07-31T19:21:04.000Z',
      streamId: messageId,
      turnId: 'turn-route-change',
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 3,
      reset: false,
      delta: ' three',
    }));
    await frames.flush();
    expect(overlayMessages(queryClient, firstWorkstreamId)[0]?.text).toBe('One two three');
  });

  it('keeps retrying ticket failures beyond the old four-attempt cutoff', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const getSocketTicket = vi.fn(async () => {
      throw new Error('offline');
    });
    const api = socketApiWith({ getSocketTicket });
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
    const workstreamId = '00000000-0000-7000-8000-000000000731';
    const getSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper() });

    await flushPromises();
    act(() => {
      FakeWebSocket.instances[0]?.open();
      FakeWebSocket.instances[0]?.message(snapshotFrame({
        sequence: 1,
        workstream: { id: workstreamId },
      }));
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

    act(() => {
      FakeWebSocket.instances[2]?.open();
      FakeWebSocket.instances[2]?.rawMessage('pong');
      FakeWebSocket.instances[2]?.message(snapshotFrame({sequence: 1, workstream: {id: workstreamId}}));
    });
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
      url: 'wss://api.rally.test/workstreams/workstream-one',
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    const { result } = renderHook(() => useWorkstreamSocket(api, 'workstream-one', true), { wrapper: createWrapper() });

    await flushPromises();
    expect(result.current.state).toBe('unavailable');
    expect(getSocketTicket).not.toHaveBeenCalled();

    online = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
    });

    expect(getSocketTicket).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('separates a room that cannot replay from a socket that merely dropped', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const getSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/workstreams/workstream-one',
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    renderHook(() => useWorkstreamSocket(api, 'workstream-one', true), { wrapper: createWrapper() });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    // The room can no longer replay what this client missed, so the client
    // closes and starts again from a canonical read. Counted as a drop like any
    // other, it would read as a flaky transport; it is the room saying the
    // client's cursor is beyond recovery, and it is the one cause that explains
    // state arriving late rather than not arriving.
    act(() => socket.message({
      type: 'resync_required',
      sequence: 14,
      latestSequence: 14,
      occurredAt: '2026-07-31T20:00:00.000Z',
      reason: 'history_unavailable',
      activeStreams: [],
      activeCompaction: null,
    }));

    expect(socketTelemetry()).toEqual([
      {
        kind: 'realtime_socket_state',
        socket: 'substream_feed',
        state: 'connected',
        cause: 'opened',
        attempts: 'zero',
      },
      {
        kind: 'realtime_socket_state',
        socket: 'substream_feed',
        state: 'retrying',
        cause: 'resync_required',
        attempts: 'zero',
      },
    ]);
  });

  it('releases an in-flight transcript range immediately when its socket closes', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: 'wss://api.rally.test/workstreams/workstream-one',
        ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(
      () => useWorkstreamSocket(api, 'workstream-one', true),
      { wrapper: createWrapper() },
    );

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const settled = result.current.loadTranscriptRange({
      snapshotId: '00000000-0000-7000-8000-000000000777',
      range: { startInclusive: 1, endExclusive: 2 },
      resumeAfterEventSequence: 0,
    }).then(() => null, (error: unknown) => error);
    expect(sentFrames(socket).at(-1)).toMatchObject({ type: 'load_transcript_range' });

    act(() => socket.close(1006));

    await expect(settled).resolves.toMatchObject({ code: 'workstream_socket_unavailable' });
  });

  it('treats a transcript-range send race as a reconnectable socket interruption', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: 'wss://api.rally.test/workstreams/workstream-one',
        ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(
      () => useWorkstreamSocket(api, 'workstream-one', true),
      { wrapper: createWrapper() },
    );

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    socket.send.mockImplementationOnce(() => {
      throw new Error('socket entered closing state');
    });

    await expect(result.current.loadTranscriptRange({
      snapshotId: '00000000-0000-7000-8000-000000000777',
      range: { startInclusive: 1, endExclusive: 2 },
      resumeAfterEventSequence: 0,
    })).rejects.toMatchObject({ code: 'workstream_socket_unavailable' });
  });

  it('releases an in-flight transcript range immediately when the room requires resync', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: 'wss://api.rally.test/workstreams/workstream-one',
        ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(
      () => useWorkstreamSocket(api, 'workstream-one', true),
      { wrapper: createWrapper() },
    );

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const settled = result.current.loadTranscriptRange({
      snapshotId: '00000000-0000-7000-8000-000000000777',
      range: { startInclusive: 1, endExclusive: 2 },
      resumeAfterEventSequence: 0,
    }).then(() => null, (error: unknown) => error);

    act(() => socket.message({
      type: 'resync_required',
      sequence: 14,
      latestSequence: 14,
      occurredAt: '2026-07-31T20:00:00.000Z',
      reason: 'history_unavailable',
      activeStreams: [],
      activeCompaction: null,
    }));

    await expect(settled).resolves.toMatchObject({ code: 'workstream_socket_unavailable' });
  });

  it('releases an in-flight transcript range on the room\'s correlated refusal', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: 'wss://api.rally.test/workstreams/workstream-one',
        ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(
      () => useWorkstreamSocket(api, 'workstream-one', true),
      { wrapper: createWrapper() },
    );

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const settled = result.current.loadTranscriptRange({
      snapshotId: '00000000-0000-7000-8000-000000000777',
      range: { startInclusive: 1, endExclusive: 2 },
      resumeAfterEventSequence: 0,
    }).then(() => null, (error: unknown) => error);
    const requestId = (sentFrames(socket).at(-1) as { requestId: string }).requestId;

    // Without the correlation this frame is indistinguishable from an
    // unsolicited protocol error, and the caller waits out its own 15-second
    // timeout before reporting a timeout the room never had.
    act(() => socket.message({
      type: 'error',
      sequence: 9,
      occurredAt: '2026-09-02T17:00:00.000Z',
      code: 'subscription_required',
      message: 'Subscribe before loading transcript ranges',
      requestId,
    }));

    // The room's code steers; its protocol prose stays off the banner and on
    // `details`, where a report can still recover it.
    await expect(settled).resolves.toMatchObject({
      code: 'subscription_required',
      message: 'This part of the transcript could not be loaded.',
      details: 'Subscribe before loading transcript ranges',
    });
  });

  it('keeps the snapshot slot held when a correlated range refusal arrives', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: 'wss://api.rally.test/workstreams/workstream-one',
        ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(
      () => useWorkstreamSocket(api, 'workstream-one', true),
      { wrapper: createWrapper() },
    );

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => result.current.requestSnapshot());
    const settled = result.current.loadTranscriptRange({
      snapshotId: '00000000-0000-7000-8000-000000000777',
      range: { startInclusive: 1, endExclusive: 2 },
      resumeAfterEventSequence: 0,
    }).then(() => null, (error: unknown) => error);
    const requestId = (sentFrames(socket).at(-1) as { requestId: string }).requestId;

    // The refusal this PR correlates is likeliest exactly here, with a
    // reconciliation snapshot still assembling — which is why the room lowered
    // `subscribed` at all. It answers the range, never the snapshot request,
    // which carries no request id to answer.
    act(() => socket.message({
      type: 'error',
      sequence: 4,
      occurredAt: '2026-09-02T17:00:00.000Z',
      code: 'subscription_required',
      message: 'Subscribe before loading transcript ranges',
      requestId,
    }));
    await expect(settled).resolves.toMatchObject({ code: 'subscription_required' });

    // The original snapshot is still outstanding, so a later reconciliation
    // trigger must not put a second one over the top of it.
    act(() => result.current.requestSnapshot());
    expect(sentFrames(socket).filter((frame) => frame.type === 'request_snapshot')).toHaveLength(1);
  });

  it('leaves an in-flight transcript range alone when an unrelated error arrives', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: 'wss://api.rally.test/workstreams/workstream-one',
        ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(
      () => useWorkstreamSocket(api, 'workstream-one', true),
      { wrapper: createWrapper() },
    );

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    let outcome: unknown = 'pending';
    void result.current.loadTranscriptRange({
      snapshotId: '00000000-0000-7000-8000-000000000777',
      range: { startInclusive: 1, endExclusive: 2 },
      resumeAfterEventSequence: 0,
    }).then((range) => { outcome = range; }, (error: unknown) => { outcome = error; });

    act(() => socket.message({
      type: 'error',
      sequence: 9,
      occurredAt: '2026-09-02T17:00:00.000Z',
      code: 'unrelated_error',
      message: 'An unrelated operation failed.',
      requestId: null,
    }));
    await flushPromises();

    expect(outcome).toBe('pending');

    // A correlated refusal naming a range this socket is not holding is the
    // case that proves the lookup rather than the null check: two readers can
    // have ranges in flight at once, and one refusal settles exactly one.
    act(() => socket.message({
      type: 'error',
      sequence: 10,
      occurredAt: '2026-09-02T17:00:01.000Z',
      code: 'subscription_required',
      message: 'Subscribe before loading transcript ranges',
      requestId: '00000000-0000-7000-8000-0000000009f9',
    }));
    await flushPromises();

    expect(outcome).toBe('pending');
  });

  it('counts one drop when a resync frame lands in the same batch as an abrupt close', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const getSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/workstreams/workstream-one',
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    renderHook(() => useWorkstreamSocket(api, 'workstream-one', true), { wrapper: createWrapper() });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    reportTelemetryProductIntent.mockClear();

    // `readyState` reaches CLOSED before the `close` event is dispatched, so a
    // frame already queued behind it is delivered to a socket that is gone but
    // has not said so yet. That is one transition, and the close listener is
    // what reports it.
    socket.readyState = FakeWebSocket.CLOSED;
    act(() => socket.message({
      type: 'resync_required',
      sequence: 14,
      latestSequence: 14,
      occurredAt: '2026-07-31T20:00:00.000Z',
      reason: 'history_unavailable',
      activeStreams: [],
      activeCompaction: null,
    }));
    act(() => socket.dispatchEvent(Object.assign(new Event('close'), { code: 1006 })));

    // One event, not two — and the surviving one says what actually happened to
    // the socket rather than what the room asked for afterwards. The depth is
    // `one` rather than `zero` because the resync frame scheduled the reconnect
    // before the close event was delivered, which is the honest reading: this
    // drop was reported with a retry already in flight.
    expect(socketTelemetry()).toEqual([{
      kind: 'realtime_socket_state',
      socket: 'substream_feed',
      state: 'retrying',
      cause: 'server_closed',
      attempts: 'one',
    }]);
  });

  it('reports the feed as stopped when the desktop goes offline', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const getSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/workstreams/workstream-one',
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    renderHook(() => useWorkstreamSocket(api, 'workstream-one', true), { wrapper: createWrapper() });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    reportTelemetryProductIntent.mockClear();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('offline')));

    // `stopped`, not `retrying`: this loop's `scheduleReconnect` refuses to arm
    // a timer while the desktop is offline, so nothing is coming until the
    // `online` event. That is the distinction the flag exists to carry — every
    // loop decides it for itself, and the cause alone cannot say.
    expect(socketTelemetry()).toEqual([{
      kind: 'realtime_socket_state',
      socket: 'substream_feed',
      state: 'stopped',
      cause: 'offline',
      attempts: 'zero',
    }]);
  });

  it('uses raw ping/pong keepalives without treating pong as an application event', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000732';
    const getSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper() });

    await flushPromises();
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.message(snapshotFrame({ sequence: 1, workstream: { id: workstreamId } }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(socket.send).toHaveBeenCalledWith('ping');
    act(() => socket.rawMessage('pong'));
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(socket.send.mock.calls.filter(([frame]) => frame === 'ping')).toHaveLength(2);
  });

});

describe('useWorkstreamSocket over the local cache', () => {
  const scope = 'global:00000000-0000-7000-8000-0000000000aa';

  function createScopedWrapper(queryClient: QueryClient): ({ children }: PropsWithChildren) => React.JSX.Element {
    return function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
      return (
        <QueryClientProvider client={queryClient}>
          <LocalCacheScopeProvider scope={scope}>{children}</LocalCacheScopeProvider>
        </QueryClientProvider>
      );
    };
  }

  function rememberedTranscript(): WorkstreamBoot['transcript'] {
    return {
      ...emptyTranscriptSnapshot(),
      snapshotThrough: 3,
      // Deliberately far ahead of anything the live room will say below.
      eventSequence: 500,
      ranges: [{
        purpose: 'latest',
        requested: { startInclusive: 3, endExclusive: 4 },
        covered: { startInclusive: 3, endExclusive: 4 },
        turns: [transcriptTurn(3, 'Remembered turn')],
        activities: [],
        pluginRuns: [],
      }],
    };
  }

  async function remember(workstreamId: string, title: string): Promise<void> {
    await clearAllLocalCache();
    await conversationSlice.write(scope, conversationCacheKey(workstreamId, '0'), {
      detail: workstreamDetail({ id: workstreamId, title }),
      transcript: rememberedTranscript(),
      initialContext: null,
      cachedAt: '2026-09-01T00:00:00.000Z',
    }, workstreamId);
  }

  it('paints the remembered conversation before the socket answers, then lets the live snapshot replace it whatever its numbers say', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-0000000007a1';
    await remember(workstreamId, 'Remembered title');
    const queryClient = new QueryClient();
    const getSocketTicket = vi.fn(async (...args: Parameters<WorkstreamSocketApi['getSocketTicket']>) => {
      void args;
      return {
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      };
    });
    const api = socketApiWith({ getSocketTicket });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createScopedWrapper(queryClient) });

    await vi.waitFor(() => {
      expect(queryDetail(queryClient, workstreamId)?.title).toBe('Remembered title');
    }, { timeout: 2_000 });
    expect(queryClient.getQueryData(workstreamFeedSourceQueryKey(workstreamId))).toBe('local_cache');
    expect(orderedTranscriptMessages(
      queryClient.getQueryData<WorkstreamTranscriptSnapshot>(['ordered-transcript', workstreamId]),
      workstreamId,
    ).map((message) => message.text)).toEqual(['Remembered turn']);
    // A seed is not a resume position: the room is asked for everything.
    expect(getSocketTicket.mock.calls[0]?.[3]).toBe(0);

    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.message(snapshotFrame({
        sequence: 1,
        workstream: { id: workstreamId, title: 'Live title' },
        transcript: {
          ...emptyTranscriptSnapshot(),
          snapshotThrough: 4,
          eventSequence: 7,
          ranges: [{
            purpose: 'latest',
            requested: { startInclusive: 4, endExclusive: 5 },
            covered: { startInclusive: 4, endExclusive: 5 },
            turns: [transcriptTurn(4, 'Live turn')],
            activities: [],
            pluginRuns: [],
          }],
        },
      }));
    });

    expect(queryDetail(queryClient, workstreamId)?.title).toBe('Live title');
    expect(queryClient.getQueryData<WorkstreamTranscriptSnapshot>(['ordered-transcript', workstreamId])?.eventSequence).toBe(7);
    expect(orderedTranscriptMessages(
      queryClient.getQueryData<WorkstreamTranscriptSnapshot>(['ordered-transcript', workstreamId]),
      workstreamId,
    ).map((message) => message.text)).toEqual(['Live turn']);
    expect(queryClient.getQueryData(workstreamFeedSourceQueryKey(workstreamId))).toBe('socket_snapshot');

    // What the room said is what the next launch will paint.
    await vi.waitFor(async () => {
      const row = await conversationSlice.read(scope, conversationCacheKey(workstreamId, '0'));
      expect(row?.detail.title).toBe('Live title');
    }, { timeout: LOCAL_CACHE_WRITE_COALESCE_MS + 2_000 });
  });

  it('rejects a room command while the seed is on screen, before any socket has answered', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-0000000007a4';
    await remember(workstreamId, 'Remembered title');
    const queryClient = new QueryClient();
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createScopedWrapper(queryClient) });
    await vi.waitFor(() => {
      expect(queryDetail(queryClient, workstreamId)?.title).toBe('Remembered title');
    }, { timeout: 2_000 });

    // The run, the elicitation, and the queue on screen are the seed's; no
    // command may address them, whichever control it comes from.
    await expect(result.current.stopHarness()).rejects.toMatchObject({ code: 'workstream_feed_seeded' });
    await expect(result.current.retryHarness()).rejects.toMatchObject({ code: 'workstream_feed_seeded' });
  });

  it('does not repaint a conversation the reader was shut out of while its row was being read', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-0000000007a5';
    await remember(workstreamId, 'Remembered title');
    const queryClient = new QueryClient();
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createScopedWrapper(queryClient) });
    // The ticket resolves on the microtask queue; the row's read does not
    // settle until a macrotask. Everything up to the socket exists, the seed
    // does not.
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const socket = FakeWebSocket.instances[0]!;
    expect(queryDetail(queryClient, workstreamId)).toBeUndefined();

    act(() => {
      socket.open();
      socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(queryDetail(queryClient, workstreamId)).toBeUndefined();
    expect(queryClient.getQueryData(workstreamFeedSourceQueryKey(workstreamId))).toBeUndefined();
  });

  it('lets a rebuilt room replace the seed even when the resume registry remembers a higher sequence', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-0000000007a3';
    await remember(workstreamId, 'Remembered title');
    const queryClient = new QueryClient();
    const getSocketTicket = vi.fn(async (...args: Parameters<WorkstreamSocketApi['getSocketTicket']>) => {
      void args;
      return {
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      };
    });
    const api = socketApiWith({ getSocketTicket });
    // The shared registry the shell provides: it outlives the query entries.
    function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
      return (
        <QueryClientProvider client={queryClient}>
          <WorkstreamSocketResumeProvider scope="user-one:workspace-one">
            <LocalCacheScopeProvider scope={scope}>{children}</LocalCacheScopeProvider>
          </WorkstreamSocketResumeProvider>
        </QueryClientProvider>
      );
    }
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useWorkstreamSocket(api, workstreamId, enabled),
      { initialProps: { enabled: true }, wrapper: Wrapper },
    );
    await vi.waitFor(() => {
      expect(queryDetail(queryClient, workstreamId)?.title).toBe('Remembered title');
    }, { timeout: 2_000 });
    act(() => {
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      socket.message(snapshotFrame({
        sequence: 500,
        workstream: { id: workstreamId, title: 'Live title' },
        transcript: { ...emptyTranscriptSnapshot(), snapshotThrough: 4, eventSequence: 7 },
      }));
    });
    expect(queryDetail(queryClient, workstreamId)?.title).toBe('Live title');

    // The screen goes away and its query entries are collected; the registry
    // keeps sequence 500. The next visit seeds from the disk again.
    rerender({ enabled: false });
    queryClient.removeQueries();
    await remember(workstreamId, 'Remembered again');
    rerender({ enabled: true });
    await vi.waitFor(() => {
      expect(queryDetail(queryClient, workstreamId)?.title).toBe('Remembered again');
    }, { timeout: 2_000 });
    expect(getSocketTicket.mock.calls[1]?.[3]).toBe(0);

    // The room was rebuilt meanwhile and answers from a lower sequence.
    act(() => {
      const socket = FakeWebSocket.instances[1]!;
      socket.open();
      socket.message(snapshotFrame({
        sequence: 5,
        workstream: { id: workstreamId, title: 'Rebuilt room' },
        transcript: { ...emptyTranscriptSnapshot(), snapshotThrough: 1, eventSequence: 3 },
      }));
    });
    expect(queryDetail(queryClient, workstreamId)?.title).toBe('Rebuilt room');
    expect(queryClient.getQueryData(workstreamFeedSourceQueryKey(workstreamId))).toBe('socket_snapshot');
  });

  it('reports a socket that never answers over a seed, and never writes the seed back', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-0000000007a2';
    await remember(workstreamId, 'Remembered title');
    // Only the clock the hook's deadline runs on is faked. The fake IndexedDB
    // schedules its own work on `setImmediate`, which stays real so the seed
    // can land while fake time stands still.
    vi.useFakeTimers({ now: new Date('2026-09-01T12:00:00.000Z'), toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const queryClient = new QueryClient();
    const getSocketTicket = vi.fn(async () => ({
      url: `wss://api.rally.test/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
    const { result } = renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: createScopedWrapper(queryClient),
    });

    const startedAt = Date.now();
    await vi.waitFor(() => {
      expect(queryDetail(queryClient, workstreamId)?.title).toBe('Remembered title');
    }, { timeout: 2_000 });
    expect(getSocketTicket).toHaveBeenCalledTimes(1);

    // The socket never answers. A seed completes no opening, so the deadline
    // still fires and a second attempt is made. `waitFor` advanced the fake
    // clock while it polled, so the remaining wait is measured from it.
    await act(async () => vi.advanceTimersByTimeAsync(9_999 - (Date.now() - startedAt)));
    expect(result.current.state).toBe('connecting');
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(result.current.state).toBe('reconnecting');
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(getSocketTicket).toHaveBeenCalledTimes(2);
    // Nor does the deadline read the seed as a recovery when it fires: the
    // attempts are counted, and the third one ending is reported as the
    // failure it is. A remembered transcript is not a live connection.
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(getSocketTicket).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(40_000));
    expect(result.current.state).toBe('unavailable');
    expect(result.current.openingError).toBe('The live connection timed out after 3 attempts.');
    // The remembered conversation stays on screen throughout.
    expect(queryDetail(queryClient, workstreamId)?.title).toBe('Remembered title');
    expect(queryClient.getQueryData(workstreamFeedSourceQueryKey(workstreamId))).toBe('local_cache');

    // And the seed did not persist itself: the row still says what it said.
    await act(async () => vi.advanceTimersByTimeAsync(LOCAL_CACHE_WRITE_COALESCE_MS));
    const row = await conversationSlice.read(scope, conversationCacheKey(workstreamId, '0'));
    expect(row?.cachedAt).toBe('2026-09-01T00:00:00.000Z');
  });
});

it('keeps inference delays attempt-scoped and clears them on settlement and conversation changes', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const queryClient = new QueryClient();
  const parentId = '00000000-0000-7000-8000-00000000062f';
  const runId = '00000000-0000-7000-8000-000000000700';
  const api = socketApiWith({ getSocketTicket: vi.fn(async () => ({
    url: `wss://api.rally.test/workstreams/${parentId}`, ticket: 'socket-ticket',
    protocols: socketTicketProtocols('socket-ticket'),
  })) });
  const { result, rerender } = renderHook(({ substreamId }) => useWorkstreamSocket(api, parentId, true, "active_workstream", undefined, true, substreamId), {
    initialProps: { substreamId: '0' }, wrapper: createWrapper(queryClient),
  });
  await flushPromises();
  const socket = FakeWebSocket.instances[0]!;
  const delay = {
    harnessRunId: runId, executionId: runId,
    attemptId: '00000000-0000-7000-8000-000000000701',
    inferenceRequestId: '00000000-0000-7000-8000-000000000702', turnId: 'turn:1',
  };
  act(() => {
    socket.open();
    socket.message({ ...snapshotFrame({ sequence: 1, workstream: { id: parentId, harnessStatus: 'running', latestHarnessRunId: runId } }), activeInferenceDelays: [delay] });
  });
  expect(result.current.activeInferenceDelays).toEqual([delay]);
  const other = { ...delay, inferenceRequestId: '00000000-0000-7000-8000-000000000703' };
  act(() => socket.message({ type: 'inference_delay_changed', sequence: 2, occurredAt: '2026-09-14T20:00:00Z', ...other, active: true }));
  expect(result.current.activeInferenceDelays).toEqual([delay, other]);
  act(() => socket.message({ type: 'inference_delay_changed', sequence: 3, occurredAt: '2026-09-14T20:00:01Z', ...delay, active: false }));
  expect(result.current.activeInferenceDelays.map((entry) => entry.inferenceRequestId)).toEqual([other.inferenceRequestId]);
  act(() => socket.message({ type: 'harness_status_changed', sequence: 4, occurredAt: '2026-09-14T20:00:02Z', status: 'completed' }));
  expect(result.current.activeInferenceDelays).toEqual([]);
  act(() => socket.message({ ...snapshotFrame({ sequence: 5, workstream: { id: parentId, harnessStatus: 'running', latestHarnessRunId: runId } }), activeInferenceDelays: [delay] }));
  expect(result.current.activeInferenceDelays).toHaveLength(1);
  rerender({ substreamId: '00000000-0000-7000-8000-000000000704' });
  expect(result.current.activeInferenceDelays).toEqual([]);
});

it('retains an active delay when a conversation remounts after its event sequence', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const queryClient = new QueryClient();
  const parentId = '00000000-0000-7000-8000-00000000062f';
  const runId = '00000000-0000-7000-8000-000000000700';
  const delay = {
    harnessRunId: runId, executionId: runId,
    attemptId: '00000000-0000-7000-8000-000000000701',
    inferenceRequestId: '00000000-0000-7000-8000-000000000702', turnId: 'turn:1',
  };
  const api = socketApiWith({ getSocketTicket: vi.fn(async () => ({
    url: `wss://api.rally.test/workstreams/${parentId}`, ticket: 'socket-ticket',
    protocols: socketTicketProtocols('socket-ticket'),
  })) });
  function Socket(): React.JSX.Element {
    const connection = useWorkstreamSocket(api, parentId, true);
    return <div data-testid="retained-delay">{connection.activeInferenceDelays.map((entry) => entry.inferenceRequestId).join(',')}</div>;
  }
  function Tree({ mounted }: { mounted: boolean }): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>
      <WorkstreamSocketResumeProvider scope="delay-review">
        {mounted ? <Socket /> : null}
      </WorkstreamSocketResumeProvider>
    </QueryClientProvider>;
  }
  const rendered = render(<Tree mounted />);
  await flushPromises();
  const socket = FakeWebSocket.instances[0]!;
  act(() => {
    socket.open();
    socket.message(snapshotFrame({ sequence: 1, workstream: { id: parentId, harnessStatus: 'running', latestHarnessRunId: runId } }));
    socket.message({ type: 'inference_delay_changed', sequence: 2, occurredAt: '2026-09-14T20:00:00Z', ...delay, active: true });
  });
  expect(rendered.getByTestId('retained-delay').textContent).toBe(delay.inferenceRequestId);
  rendered.rerender(<Tree mounted={false} />);
  rendered.rerender(<Tree mounted />);
  await flushPromises();
  const resumed = FakeWebSocket.instances.at(-1)!;
  act(() => resumed.open());
  expect(sentFrames(resumed)).toContainEqual(expect.objectContaining({ type: 'subscribe', afterSequence: 2 }));
  expect(rendered.getByTestId('retained-delay').textContent).toBe(delay.inferenceRequestId);
  act(() => resumed.message({ type: 'inference_delay_changed', sequence: 3, occurredAt: '2026-09-14T20:00:01Z', ...delay, active: false }));
  expect(rendered.getByTestId('retained-delay').textContent).toBe('');
});
