import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockDashboard, BlockDashboardPreference, Message, WorkstreamBoot, WorkstreamDetail, WorkstreamSummary } from './types';
import { setCachedWorkstreams } from './workstreams-cache';
import {
  applyActiveStreamCheckpoints,
  applyStreamingSocketEvent,
  insertMessage,
  mergeCanonicalTranscript,
  nextTranscriptSequence,
  reconcileCanonicalTranscript,
  replaceWithCanonicalTranscript,
  SOCKET_STABLE_CONNECTION_MS,
  socketHeartbeatDelay,
  socketReconnectDelay,
  useWorkstreamSocket,
  type WorkstreamSocketApi,
} from './use-workstream-socket';
import {
  WorkstreamSocketPool,
  useRetainedWorkstreamSocket,
} from './workstream-socket-pool';
import { WorkstreamSocketResumeProvider } from './workstream-socket-resume';

const workspaceCreateMessage = vi.hoisted(() => vi.fn());
vi.mock('./workspace-socket', () => ({
  useWorkspaceSocket: () => ({ state: 'connected', createMessage: workspaceCreateMessage }),
}));
vi.mock('./use-workstream-control-socket', () => ({ useWorkstreamControlSocket: vi.fn() }));

import type * as TelemetryModule from './telemetry';

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
function stubAnimationFrames(): { flush: () => Promise<void> } {
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    nextId += 1;
    queue.set(nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    queue.delete(id);
  });
  return {
    async flush(): Promise<void> {
      for (let round = 0; round < 100_000 && queue.size > 0; round += 1) {
        const pending = [...queue.values()];
        queue.clear();
        await act(async () => {
          for (const callback of pending) callback(performance.now());
        });
      }
    },
  };
}

function socketApiWith(overrides: Partial<WorkstreamSocketApi>): WorkstreamSocketApi {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected socket API call.');
  };
  return {
    getMessages: vi.fn(unexpected),
    getSocketTicket: vi.fn(unexpected),
    getWorkstreamControlSocketTicket: vi.fn(unexpected),
    getWorkstream: vi.fn(unexpected),
    messageMentionPayload: vi.fn(async () => []),
    ...overrides,
  } satisfies WorkstreamSocketApi;
}

function workstreamSummary(overrides: Partial<WorkstreamSummary> = {}): WorkstreamSummary {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    title: 'Canonical work stream',
    titleStatus: 'settled',
    origin: 'ad_hoc',
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
    automationRuns: [],
    ...overrides,
  };
}

/** `getWorkstream` answers the whole of an open now, not just the detail. */
function workstreamBoot(overrides: Partial<WorkstreamDetail> = {}): WorkstreamBoot {
  return {
    ...workstreamDetail(overrides),
    messageFeed: { items: [], nextCursor: null, newerCursor: null },
    resumeFeed: null,
    blockDashboardPreference: { visible: false, updatedAt: null },
  };
}

/**
 * A work-stream detail in the shape the room puts on the wire, which is not the
 * shape the renderer holds. The hook validates every frame against the shared
 * contract before applying it, so a snapshot built from the renderer's own
 * `WorkstreamDetail` is rejected as malformed and silently ignored — a test
 * written that way passes its assertions against the state it set up itself.
 */
function wireWorkstreamDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-7000-8000-000000000091',
    workspaceId: '00000000-0000-7000-8000-000000000001',
    title: 'Wire work stream',
    objective: 'Wire objective',
    originType: 'ad_hoc',
    originLabel: null,
    createdByUserId: null,
    automationSubscriptionId: null,
    automationRunId: null,
    plannedFor: null,
    harnessStatus: 'completed',
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: '2026-07-31T19:00:00.000Z',
    createdAt: '2026-07-31T19:00:00.000Z',
    updatedAt: '2026-07-31T19:00:00.000Z',
    archivedAt: null,
    participants: [],
    viewers: [],
    resources: [],
    connections: [],
    openElicitations: [],
    suggestions: [],
    latestHarnessRunId: null,
    ...overrides,
  };
}

function wireTextMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-7000-8000-000000000103',
    clientMessageId: null,
    workspaceId: '00000000-0000-7000-8000-000000000001',
    workstreamId: '00000000-0000-7000-8000-000000000091',
    author: { type: 'agent' },
    messageType: 'text',
    textContent: 'Canonical text.',
    structuredContent: null,
    mentions: [],
    sequenceNumber: 1,
    createdAt: '2026-07-31T19:20:00.000Z',
    editedAt: null,
    ...overrides,
  };
}

function snapshotFrame(input: {
  sequence: number;
  workstream?: Record<string, unknown>;
  messages?: Record<string, unknown>[];
  resumeFeed?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    type: 'snapshot',
    sequence: input.sequence,
    occurredAt: '2026-07-31T19:20:00.000Z',
    workstream: wireWorkstreamDetail(input.workstream),
    messageFeed: { items: input.messages ?? [], nextCursor: null, newerCursor: null },
    resumeFeed: input.resumeFeed ?? null,
    activeStreams: [],
    activeCompaction: null,
  };
}

/** The frames a socket was asked to send, in order, excluding raw keepalives. */
function sentFrames(socket: FakeWebSocket): { type: string }[] {
  return socket.send.mock.calls
    .map(([frame]) => frame)
    .filter((frame): frame is string => typeof frame === 'string' && frame.startsWith('{'))
    .map((frame) => JSON.parse(frame) as { type: string });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  workspaceCreateMessage.mockReset();
  reportTelemetryProductIntent.mockClear();
  FakeWebSocket.instances = [];
});

describe('useWorkstreamSocket', () => {
  it('reuses the same socket when returning to a recently viewed work stream', async () => {
    const fiveMinutesMs = 5 * 60_000;
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000621';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000622';
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
      { wrapper: createWrapper() },
    );
    await flushPromises();
    const firstSocket = FakeWebSocket.instances[0]!;
    const firstClose = vi.spyOn(firstSocket, 'close');

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <ActiveConnection workstreamId={secondWorkstreamId} />
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(firstClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(fiveMinutesMs - 1));
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
    const fiveMinutesMs = 5 * 60_000;
    vi.useFakeTimers({ now: new Date('2026-08-25T12:00:00.000Z') });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000623';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000624';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async (workstreamId: string) => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: `socket-ticket-${workstreamId}`,
        protocols: socketTicketProtocols(`socket-ticket-${workstreamId}`),
      })),
    });
    const view = render(
      <WorkstreamSocketPool activeWorkstreamId={firstWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <div>First</div>
      </WorkstreamSocketPool>,
      { wrapper: createWrapper() },
    );
    await flushPromises();
    const firstSocket = FakeWebSocket.instances[0]!;
    const firstClose = vi.spyOn(firstSocket, 'close');

    view.rerender(
      <WorkstreamSocketPool activeWorkstreamId={secondWorkstreamId} api={api} backgroundWorkstreamIds={[]}>
        <div>Second</div>
      </WorkstreamSocketPool>,
    );
    await flushPromises();
    act(() => vi.advanceTimersByTime(fiveMinutesMs - 1));
    expect(firstClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(firstClose).toHaveBeenCalledTimes(1);
  });

  it('routes a message command through the shared workspace connection', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000601';
    const messageId = '00000000-0000-7000-8000-000000000604';
    const clientMessageId = 'client-message-reconnect';
    const savedMessage: Message = {
      id: messageId,
      clientMessageId,
      workstreamId,
      sequenceNumber: 9,
      authorType: 'human',
      messageType: 'text',
      text: 'Please continue.',
      mentions: [],
      attachments: [],
      createdAt: '2026-08-17T12:00:01.000Z',
    };
    workspaceCreateMessage.mockResolvedValue(savedMessage);
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
    await expect(result.current.createMessage({
        text: 'Please continue.',
        clientId: clientMessageId,
      })).resolves.toEqual(savedMessage);
    expect(workspaceCreateMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'create_message',
      workstreamId,
      substreamId: '0',
      payload: {
        text: 'Please continue.',
        clientMessageId,
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    }));
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

  it('loads an older message page through a correlated SubstreamAgent socket read', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const workstreamId = '00000000-0000-7000-8000-000000000621';
    const messageId = '00000000-0000-7000-8000-000000000622';
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
    const pagePromise = result.current.loadMessagePage({ before: '42', limit: 25 });
    const command = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as {
      type: string;
      requestId: string;
      limit: number;
      cursor: { direction: string; value: string };
    };
    expect(command).toMatchObject({
      type: 'load_message_page',
      limit: 25,
      cursor: { direction: 'before', value: '42' },
    });

    act(() => socket.message({
      type: 'message_page',
      requestId: command.requestId,
      occurredAt: '2026-08-18T12:00:00.000Z',
      page: {
        items: [{
          id: messageId,
          clientMessageId: null,
          workspaceId: '00000000-0000-7000-8000-000000000623',
          workstreamId,
          sequenceNumber: 21,
          author: { type: 'agent' },
          messageType: 'text',
          textContent: 'An older message',
          structuredContent: null,
          mentions: [],
          attachments: [],
          createdAt: '2026-08-18T11:00:00.000Z',
          editedAt: null,
        }],
        nextCursor: '21',
        newerCursor: null,
      },
    }));

    await expect(pagePromise).resolves.toMatchObject({
      items: [{ id: messageId, text: 'An older message' }],
      nextCursor: '21',
      newerCursor: null,
    });
  });

  it('applies personal and shared HyperSight updates without letting stale runs win', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000301';
    const versionId = '00000000-0000-7000-8000-000000000302';
    const blockId = '00000000-0000-7000-8000-000000000303';
    const initial: BlockDashboard = {
      versionId,
      versionNumber: 1,
      blocks: [{ id: blockId, prompt: 'Summarize', latestRun: null }],
      updatedAt: '2026-08-07T12:00:00.000Z',
    };
    queryClient.setQueryData(['block-dashboard', workstreamId], initial);
    queryClient.setQueryData<BlockDashboardPreference>(['block-dashboard-preference', workstreamId], {
      visible: false,
      updatedAt: null,
    });
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
      type: 'block_dashboard_block_run_updated',
      sequence: 1,
      occurredAt: '2026-08-07T12:00:01.000Z',
      run: {
        id: '00000000-0000-7000-8000-000000000304',
        blockId,
        configurationVersionId: versionId,
        triggerSequence: 1,
        status: 'completed',
        markdown: '- First result',
        error: null,
        createdAt: '2026-08-07T12:00:01.000Z',
        startedAt: '2026-08-07T12:00:02.000Z',
        completedAt: '2026-08-07T12:00:03.000Z',
      },
    }));
    expect(queryClient.getQueryData<BlockDashboard>(['block-dashboard', workstreamId])?.blocks[0]?.latestRun)
      .toMatchObject({ status: 'completed', markdown: '- First result' });

    act(() => socket.message({
      type: 'block_dashboard_block_run_updated',
      sequence: 2,
      occurredAt: '2026-08-07T12:00:04.000Z',
      run: {
        id: '00000000-0000-7000-8000-000000000305',
        blockId,
        configurationVersionId: versionId,
        triggerSequence: 3,
        status: 'completed',
        markdown: 'Newest result',
        error: null,
        createdAt: '2026-08-07T12:00:03.000Z',
        startedAt: '2026-08-07T12:00:03.000Z',
        completedAt: '2026-08-07T12:00:04.000Z',
      },
    }));
    act(() => socket.message({
      type: 'block_dashboard_block_run_updated',
      sequence: 3,
      occurredAt: '2026-08-07T12:00:05.000Z',
      run: {
        id: '00000000-0000-7000-8000-000000000309',
        blockId,
        configurationVersionId: versionId,
        triggerSequence: 2,
        status: 'completed',
        markdown: 'Late stale result',
        error: null,
        createdAt: '2026-08-07T12:00:02.000Z',
        startedAt: '2026-08-07T12:00:03.000Z',
        completedAt: '2026-08-07T12:00:05.000Z',
      },
    }));
    expect(queryClient.getQueryData<BlockDashboard>(['block-dashboard', workstreamId])?.blocks[0]?.latestRun?.markdown)
      .toBe('Newest result');

    act(() => socket.message({
      type: 'block_dashboard_block_run_updated',
      sequence: 4,
      occurredAt: '2026-08-07T12:00:05.000Z',
      run: {
        id: '00000000-0000-7000-8000-000000000310',
        blockId,
        configurationVersionId: '00000000-0000-7000-8000-000000000399',
        triggerSequence: 4,
        status: 'completed',
        markdown: 'Other configuration result',
        error: null,
        createdAt: '2026-08-07T12:00:04.000Z',
        startedAt: '2026-08-07T12:00:04.000Z',
        completedAt: '2026-08-07T12:00:05.000Z',
      },
    }));
    expect(queryClient.getQueryData<BlockDashboard>(['block-dashboard', workstreamId])?.blocks[0]?.latestRun?.markdown)
      .toBe('Newest result');

    const next: BlockDashboard = {
      versionId: '00000000-0000-7000-8000-000000000306',
      versionNumber: 2,
      blocks: [{ id: blockId, prompt: 'List decisions', latestRun: null }],
      updatedAt: '2026-08-07T12:00:05.000Z',
    };
    act(() => socket.message({
      type: 'block_dashboard_configuration_updated',
      sequence: 5,
      occurredAt: '2026-08-07T12:00:05.000Z',
      blockDashboard: next,
    }));
    expect(queryClient.getQueryData<BlockDashboard>(['block-dashboard', workstreamId])).toEqual(next);

    act(() => socket.message({
      type: 'block_dashboard_preference_updated',
      occurredAt: '2026-08-07T12:00:06.000Z',
      preference: { visible: true, updatedAt: '2026-08-07T12:00:06.000Z' },
    }));
    expect(queryClient.getQueryData<BlockDashboardPreference>(['block-dashboard-preference', workstreamId]))
      .toEqual({ visible: true, updatedAt: '2026-08-07T12:00:06.000Z' });

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

  it('advances cached read bounds when a canonical attention message arrives', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workspaceId = '00000000-0000-7000-8000-000000000201';
    const workstreamId = '00000000-0000-7000-8000-000000000202';
    const messageId = '00000000-0000-7000-8000-000000000203';
    const summary: WorkstreamSummary = {
      id: workstreamId,
      title: 'Watched activity',
      titleStatus: 'settled' as const,
      origin: 'ad_hoc',
      harnessStatus: 'completed',
      scope: 'workspace',
      latestAttentionSequenceNumber: 3,
      readThroughSequenceNumber: 3,
      manualUnreadFromSequenceNumber: null,
      manualUnreadGeneration: 0,
      hasUnread: false,
      firstUnreadSequenceNumber: null,
      nextPendingWakeup: null,
      pinPosition: null,
      lastActivityAt: '2026-07-31T19:20:00.000Z',
    };
    const detail: WorkstreamDetail = {
      ...summary,
      createdAt: '2026-07-31T19:00:00.000Z',
      participants: [],
      viewers: [],
      resources: [],
      connections: [],
      backgroundTasks: [],
      automationRuns: [],
    };
    queryClient.setQueryData(['workstream', workstreamId], detail);
    setCachedWorkstreams(queryClient, [summary]);
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
      type: 'message_created',
      sequence: 1,
      occurredAt: '2026-07-31T19:21:00.000Z',
      message: {
        id: messageId,
        clientMessageId: 'activity:provider-event-one',
        workspaceId,
        workstreamId,
        author: { type: 'system' },
        messageType: 'system',
        textContent: 'A watched resource changed.',
        structuredContent: { kind: 'connected_activity' },
        mentions: [],
        attachments: [],
        sequenceNumber: 8,
        attentionSequenceNumber: 4,
        createdAt: '2026-07-31T19:21:00.000Z',
        editedAt: null,
      },
    }));

    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId])).toMatchObject({
      latestAttentionSequenceNumber: 4,
      readThroughSequenceNumber: 3,
      hasUnread: true,
      firstUnreadSequenceNumber: 4,
      lastActivityAt: '2026-07-31T19:21:00.000Z',
    });
    expect(queryClient.getQueryData<WorkstreamSummary[]>(['workstreams'])?.[0]).toMatchObject({
      latestAttentionSequenceNumber: 4,
      hasUnread: true,
      firstUnreadSequenceNumber: 4,
    });
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

  it('retains previously loaded history when the newest canonical page refreshes', () => {
    const message = (id: string, sequenceNumber: number): Message => ({
      id,
      workstreamId: 'workstream-one',
      sequenceNumber,
      authorType: 'agent',
      messageType: 'text',
      text: id,
      createdAt: `2026-07-31T19:${String(sequenceNumber).padStart(2, '0')}:00.000Z`,
    });
    const older = message('older', 1);
    const staleLatest = message('latest', 201);
    const refreshedLatest = { ...staleLatest, text: 'refreshed' };

    expect(mergeCanonicalTranscript([older, staleLatest], [refreshedLatest])).toEqual([older, refreshedLatest]);
    expect(replaceWithCanonicalTranscript([older, staleLatest], [refreshedLatest])).toEqual([older, refreshedLatest]);
  });

  it('retains an active assistant stream across a canonical refresh', () => {
    const streaming: Message = {
      id: 'streaming-message',
      workstreamId: 'workstream-one',
      sequenceNumber: 9,
      authorType: 'agent',
      messageType: 'text',
      text: 'The response so far',
      createdAt: '2026-07-31T19:20:00.000Z',
      streaming: true,
      realtimeOrder: { anchorSequenceNumber: 9, eventSequence: 12, placement: 'at_anchor' },
    };

    expect(mergeCanonicalTranscript([streaming], [])).toEqual([streaming]);
    expect(replaceWithCanonicalTranscript([streaming], [])).toEqual([]);
    expect(reconcileCanonicalTranscript([streaming], [], 'running')).toEqual([streaming]);
    expect(reconcileCanonicalTranscript([streaming], [], 'failed')).toEqual([]);
  });

  it('joins an unseen active stream at its checkpoint and appends only new chunks', () => {
    const workstreamId = '00000000-0000-7000-8000-000000000071';
    const messageId = '00000000-0000-7000-8000-000000000072';
    const cursors = new Map();
    let transcript = applyActiveStreamCheckpoints([], [{
      messageId,
      harnessRunId: '00000000-0000-7000-8000-000000000073',
      turnId: 'turn-cold-join',
      epoch: 0,
      streamSeq: 2,
      seenTurnIds: ['turn-cold-join'],
      text: 'Already streamed',
      turnStartOffset: 0,
      roomSequence: 20,
      createdAt: '2026-07-31T19:20:00.000Z',
    }], workstreamId, cursors);

    // Catch-up may overlap the checkpoint when a frame lands during snapshot
    // loading. Its Bind cursor prevents the prefix being appended twice.
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 21,
      occurredAt: '2026-07-31T19:20:01.000Z',
      messageId,
      turnId: 'turn-cold-join',
      epoch: 0,
      streamSeq: 2,
      reset: false,
      delta: ' streamed',
    }, workstreamId, cursors);
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 22,
      occurredAt: '2026-07-31T19:20:02.000Z',
      messageId,
      turnId: 'turn-cold-join',
      epoch: 0,
      streamSeq: 3,
      reset: false,
      delta: ' and live',
    }, workstreamId, cursors);

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: messageId,
      text: 'Already streamed and live',
      streaming: true,
    });
  });

  it('reanchors a cold-join checkpoint after canonical history arrives', () => {
    const workstreamId = '00000000-0000-7000-8000-000000000074';
    const messageId = '00000000-0000-7000-8000-000000000075';
    const cursors = new Map();
    const checkpoint = applyActiveStreamCheckpoints([], [{
      messageId,
      harnessRunId: '00000000-0000-7000-8000-000000000076',
      turnId: 'turn-cold-order',
      epoch: 0,
      streamSeq: 1,
      seenTurnIds: ['turn-cold-order'],
      text: 'Current response',
      turnStartOffset: 0,
      roomSequence: 40,
      createdAt: '2026-07-31T19:20:02.000Z',
    }], workstreamId, cursors);
    const canonical: Message[] = [{
      id: '00000000-0000-7000-8000-000000000077',
      workstreamId,
      sequenceNumber: 39,
      authorType: 'human',
      messageType: 'text',
      text: 'Triggering message',
      createdAt: '2026-07-31T19:20:01.000Z',
    }];

    const merged = mergeCanonicalTranscript(checkpoint, canonical);

    expect(merged.map((message) => message.id)).toEqual([canonical[0]?.id, messageId]);
    expect(merged[1]?.realtimeOrder?.anchorSequenceNumber).toBe(40);
  });

  it('drops synthetic realtime tool rows after a terminal canonical refresh', () => {
    const canonicalTool: Message = {
      id: '00000000-0000-7000-8000-000000000081',
      workstreamId: 'workstream-one',
      sequenceNumber: 11,
      authorType: 'agent',
      messageType: 'tool_event',
      createdAt: '2026-07-31T19:20:02.000Z',
      toolEvent: {
        id: '00000000-0000-7000-8000-000000000081',
        name: 'google_drive_search',
        status: 'completed',
      },
    };
    const staleRealtimeTool: Message = {
      ...canonicalTool,
      id: `tool-${canonicalTool.id}`,
      toolEvent: { ...canonicalTool.toolEvent!, status: 'started' },
      realtimeOrder: {
        anchorSequenceNumber: 12,
        eventSequence: 91,
        placement: 'before_anchor',
      },
    };

    expect(replaceWithCanonicalTranscript([staleRealtimeTool], [canonicalTool])).toEqual([canonicalTool]);
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
    const frames = stubAnimationFrames();
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
    await frames.flush();

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
      messageId,
      harnessRunId: '00000000-0000-7000-8000-000000000703',
      turnId: 'turn-paced',
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => socket.message({
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-08-23T12:00:00.100Z',
      messageId,
      turnId: 'turn-paced',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'A burst of text held back by the paced reveal.',
    }));

    // The wire frame landed, and nothing of it is visible yet: the reveal
    // loop, not the socket event, is what grows the message.
    const held = queryClient.getQueryData<Message[]>(['messages', workstreamId])?.[0];
    expect(held?.streaming).toBe(true);
    expect(held?.text).toBe('');
    await frames.flush();
    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])?.[0]?.text)
      .toBe('A burst of text held back by the paced reveal.');
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
        messageId,
        harnessRunId: '00000000-0000-7000-8000-000000000713',
        turnId: 'turn-hidden',
        epoch: 0,
        streamSeq: 0,
        reset: false,
      }));
      act(() => socket.message({
        type: 'stream_delta',
        sequence: 2,
        occurredAt: '2026-08-23T12:00:00.100Z',
        messageId,
        turnId: 'turn-hidden',
        epoch: 0,
        streamSeq: 1,
        reset: false,
        delta: 'Shown at once — no animation frames fire in a hidden window.',
      }));

      expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])?.[0]?.text)
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
      messageId,
      harnessRunId: '00000000-0000-7000-8000-000000000733',
      turnId: 'turn-inherited',
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => socket.message({
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-08-23T12:00:00.100Z',
      messageId,
      turnId: 'turn-inherited',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'Held back across the remount.',
    }));
    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])?.[0]?.text).toBe('');

    rendered.rerender(<Tree mounted={false} />);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      rendered.rerender(<Tree mounted />);
      await flushPromises();
      expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])?.[0]?.text)
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
      messageId,
      turnId: 'turn-retry',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'The first attempt, mostly unrevealed.',
    }, workstreamId, cursors, { paced: true });
    // Partially reveal the first attempt, then let a reset replace it.
    cursors.get(messageId)!.revealed = 9;
    transcript = applyStreamingSocketEvent(transcript, {
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-08-23T12:00:00.500Z',
      messageId,
      turnId: 'turn-retry',
      epoch: 1,
      streamSeq: 2,
      reset: true,
      delta: 'A fresh attempt.',
    }, workstreamId, cursors, { paced: true });

    // The retracted text disappears at once — the reveal clamps back to the
    // turn's start — and the replacement paces in from there.
    expect(transcript.find((message) => message.id === messageId)?.text).toBe('');
    expect(cursors.get(messageId)).toMatchObject({
      receivedText: 'A fresh attempt.',
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
    await frames.flush();
    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])?.[0]?.text).toBe('One two');
  });

  it('self-heals stale and duplicate realtime tool rows after reconnect without a reload', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000091';
    const invocationId = '00000000-0000-7000-8000-000000000092';
    const staleTool: Message = {
      id: `tool-${invocationId}`,
      workstreamId,
      sequenceNumber: 4,
      authorType: 'agent',
      messageType: 'tool_event',
      createdAt: '2026-07-31T19:20:00.000Z',
      realtimeOrder: { anchorSequenceNumber: 4, eventSequence: 8, placement: 'before_anchor' },
      toolEvent: { id: invocationId, name: 'firecrawl.fetch', status: 'started' },
    };
    const wireToolMessage = wireTextMessage({
      id: invocationId,
      workstreamId,
      messageType: 'tool',
      textContent: '',
      sequenceNumber: 5,
      structuredContent: {
        invocation: {
          id: invocationId,
          harnessRunId: '00000000-0000-7000-8000-000000000093',
          toolCallId: 'call-one',
          toolName: 'firecrawl.fetch',
          activityName: null,
          connectionId: null,
          plugin: null,
          status: 'completed',
          inputSummary: 'https://example.test',
          outputSummary: null,
          startedAt: null,
          completedAt: null,
          error: null,
        },
      },
    });
    // Written out rather than derived through `mapMessage`: the mapping is part
    // of what this test covers, so expecting its own output would assert
    // nothing.
    const canonicalTool: Message = {
      id: invocationId,
      workstreamId,
      sequenceNumber: 5,
      authorType: 'agent',
      messageType: 'tool_event',
      text: '',
      mentions: [],
      attachments: [],
      createdAt: '2026-07-31T19:20:00.000Z',
      attentionSequenceNumber: null,
      toolEvent: {
        id: invocationId,
        name: 'firecrawl.fetch',
        summary: 'https://example.test',
        status: 'completed',
        input: 'https://example.test',
      },
    };
    queryClient.setQueryData(['messages', workstreamId], [staleTool]);
    queryClient.setQueryData(['block-dashboard', workstreamId], { versionId: null, versionNumber: 0, blocks: [], updatedAt: null });
    queryClient.setQueryData(['block-dashboard-preference', workstreamId], { visible: false, updatedAt: null });
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
    act(() => first.close());
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    await flushPromises();

    // The cursor is the reconciliation: the reconnect subscribes, and the room
    // answers a cursor it cannot replay from with the canonical snapshot. No
    // REST call is made for it — `socketApiWith` throws on any it did not stub.
    expect(sentFrames(second)).toEqual([{ type: 'subscribe', afterSequence: 0 }]);
    act(() => second.message(snapshotFrame({
      sequence: 6,
      workstream: { id: workstreamId, harnessStatus: 'completed' },
      messages: [wireToolMessage],
    })));
    await flushPromises();

    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])).toEqual([canonicalTool]);
    expect(queryClient.getQueryState(['block-dashboard', workstreamId])?.isInvalidated).toBe(true);
  });

  it('shows the name Rally gives a work stream in its header and its sidebar row', async () => {
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
    }));

    // The event settles the skeleton as well as the text: `automatic` is a
    // name, just one a later pass may still improve on.
    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId]))
      .toMatchObject({ title: 'Rally download link email to Danny', titleStatus: 'automatic' });
    expect(queryClient.getQueryData<WorkstreamSummary[]>(['workstreams'])).toEqual([
      { id: workstreamId, title: 'Rally download link email to Danny', titleStatus: 'automatic' },
      { id: '00000000-0000-7000-8000-000000000402', title: 'August planning', titleStatus: 'settled' },
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

  it('stops dialling a work stream it has just been shut out of', async () => {
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
    queryClient.setQueryData(['messages', workstreamId], [{ id: 'message-1' }] as Message[]);
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
    expect(queryClient.getQueryData(['messages', workstreamId])).toBeUndefined();
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
    const api = socketApiWith({
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
      getWorkstream: vi.fn(async () => workstreamBoot({ id: workstreamId, harnessStatus: 'completed' })),
      getMessages: vi.fn(async () => []),
    });
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), { wrapper: createWrapper(queryClient) });

    await flushPromises();
    act(() => FakeWebSocket.instances[0]!.open());
    act(() => FakeWebSocket.instances[0]!.close());
    await vi.advanceTimersByTimeAsync(90_000);
    await flushPromises();

    // The revoked case must not have turned every close into a dead end.
    expect(api.getSocketTicket).toHaveBeenCalledTimes(2);
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
      { type: 'subscribe', afterSequence: 0 },
      { type: 'request_snapshot' },
    ]);
    queryClient.setQueryData(['workstream-context', workstreamId, null], { resources: [] });
    act(() => socket.message(snapshotFrame({
      sequence: 2,
      workstream: {
        id: workstreamId,
        harnessStatus: 'running',
        latestHarnessRunId: runId,
        latestHarnessRun,
      },
    })));
    await flushPromises();

    // A snapshot carries no context, so repairing drift has to mark it stale.
    expect(queryClient.getQueryState(['workstream-context', workstreamId, null])?.isInvalidated).toBe(true);

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
    // recovery invalidates that query but never merges a parallel REST list.
    expect(queryClient.getQueryData<WorkstreamSummary[]>(['workstreams'])).toEqual([{
      ...cachedSummary,
      harnessStatus: 'running',
    }]);
    expect(queryClient.getQueryState(['workstreams'])?.isInvalidated).toBe(true);
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
      getWorkstream: vi.fn(async () => workstreamBoot({ id: workstreamId, harnessStatus: 'needs_input' })),
      getMessages: vi.fn(async () => []),
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

  it('does not lose socket messages that arrive while a snapshot request is in flight', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workspaceId = '00000000-0000-7000-8000-000000000101';
    const workstreamId = '00000000-0000-7000-8000-000000000102';
    const messageId = '00000000-0000-7000-8000-000000000103';
    const socketMessage = {
      id: messageId,
      clientMessageId: null,
      workspaceId,
      workstreamId,
      author: { type: 'agent' as const },
      messageType: 'text' as const,
      textContent: 'Arrived while reconciling.',
      structuredContent: null,
      mentions: [],
      sequenceNumber: 12,
      attentionSequenceNumber: 7,
      createdAt: '2026-07-31T19:20:02.000Z',
      editedAt: null,
    };
    const canonicalMessage: Message = {
      id: messageId,
      workstreamId,
      sequenceNumber: 12,
      attentionSequenceNumber: 7,
      authorType: 'agent',
      messageType: 'text',
      text: 'Arrived while reconciling.',
      attachments: [],
      mentions: [],
      createdAt: '2026-07-31T19:20:02.000Z',
    };
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
      sequence: 10,
      occurredAt: '2026-07-31T19:20:00.000Z',
      status: 'completed',
    }));
    expect(sentFrames(socket)).toEqual([
      { type: 'subscribe', afterSequence: 0 },
      { type: 'request_snapshot' },
    ]);

    // Published after the request was sent, so it reaches the client ahead of
    // an answer assembled before it existed.
    act(() => socket.message({
      type: 'message_created',
      sequence: 12,
      occurredAt: '2026-07-31T19:20:02.000Z',
      message: socketMessage,
    }));
    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])).toEqual([canonicalMessage]);

    // The room's answer is older than what the client has already applied. The
    // ordering guard drops it, which is the whole reason this path needs no
    // retry: the newer state is already installed, so there is nothing to go
    // back for.
    act(() => socket.message(snapshotFrame({ sequence: 11, workstream: { id: workstreamId } })));
    await flushPromises();

    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])).toEqual([canonicalMessage]);
    // And the dropped answer released the slot rather than wedging it: a later
    // status change can still ask again.
    act(() => socket.message({
      type: 'harness_status_changed',
      sequence: 13,
      occurredAt: '2026-07-31T19:20:03.000Z',
      status: 'idle',
    }));
    expect(sentFrames(socket)).toEqual([
      { type: 'subscribe', afterSequence: 0 },
      { type: 'request_snapshot' },
      { type: 'request_snapshot' },
    ]);
  });

  it('treats needs-input as terminal and reconciles synthetic realtime rows', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000111';
    const invocationId = '00000000-0000-7000-8000-000000000112';
    const staleTool: Message = {
      id: `tool-${invocationId}`,
      workstreamId,
      sequenceNumber: 4,
      authorType: 'agent',
      messageType: 'tool_event',
      createdAt: '2026-07-31T19:20:00.000Z',
      realtimeOrder: { anchorSequenceNumber: 4, eventSequence: 8, placement: 'before_anchor' },
      toolEvent: { id: invocationId, name: 'rally.ask', status: 'started' },
    };
    const wireToolMessage = wireTextMessage({
      id: invocationId,
      workstreamId,
      messageType: 'tool',
      textContent: '',
      sequenceNumber: 5,
      structuredContent: {
        invocation: {
          id: invocationId,
          harnessRunId: '00000000-0000-7000-8000-000000000113',
          toolCallId: 'call-ask',
          toolName: 'rally.ask',
          activityName: null,
          connectionId: null,
          plugin: null,
          status: 'completed',
          inputSummary: 'Which repository?',
          outputSummary: null,
          startedAt: null,
          completedAt: null,
          error: null,
        },
      },
    });
    const canonicalTool: Message = {
      id: invocationId,
      workstreamId,
      sequenceNumber: 5,
      authorType: 'agent',
      messageType: 'tool_event',
      text: '',
      mentions: [],
      attachments: [],
      createdAt: '2026-07-31T19:20:00.000Z',
      attentionSequenceNumber: null,
      toolEvent: {
        id: invocationId,
        name: 'rally.ask',
        summary: 'Which repository?',
        status: 'completed',
        input: 'Which repository?',
      },
    };
    queryClient.setQueryData(['messages', workstreamId], [staleTool]);
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
      status: 'needs_input',
    }));
    await flushPromises();

    expect(sentFrames(socket)).toEqual([
      { type: 'subscribe', afterSequence: 0 },
      { type: 'request_snapshot' },
    ]);
    act(() => socket.message(snapshotFrame({
      sequence: 2,
      workstream: { id: workstreamId, harnessStatus: 'needs_input' },
      messages: [wireToolMessage],
    })));
    await flushPromises();

    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])).toEqual([canonicalTool]);
  });

  it('does not pull the reader backwards when a later snapshot carries a resume window', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const workstreamId = '00000000-0000-7000-8000-000000000151';
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

    // Arriving: the reader is behind, so the resume window is what they see.
    act(() => socket.message(snapshotFrame({
      sequence: 5,
      workstream: { id: workstreamId },
      messages: [wireTextMessage({ id: '00000000-0000-7000-8000-000000000152', sequenceNumber: 90 })],
      resumeFeed: {
        items: [wireTextMessage({ id: '00000000-0000-7000-8000-000000000153', sequenceNumber: 12 })],
        nextCursor: '12',
        newerCursor: '13',
      },
    })));
    await flushPromises();
    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])?.map((m) => m.sequenceNumber))
      .toEqual([12]);

    // Reconciling: the same frame shape, but the reader has been watching this
    // run. Read acknowledgement stops while the window is unfocused, so their
    // first-unread is still far behind and the room keeps sending a resume
    // window — applying it here would throw away what they just watched arrive.
    act(() => socket.message({
      type: 'harness_status_changed',
      sequence: 6,
      occurredAt: '2026-07-31T19:20:00.000Z',
      status: 'completed',
    }));
    act(() => socket.message(snapshotFrame({
      sequence: 7,
      workstream: { id: workstreamId },
      messages: [wireTextMessage({ id: '00000000-0000-7000-8000-000000000154', sequenceNumber: 91 })],
      resumeFeed: {
        items: [wireTextMessage({ id: '00000000-0000-7000-8000-000000000153', sequenceNumber: 12 })],
        nextCursor: '12',
        newerCursor: '13',
      },
    })));
    await flushPromises();

    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])?.map((m) => m.sequenceNumber))
      .toEqual([91]);
    expect(queryClient.getQueryData(['messages-newer-cursor', workstreamId])).toBeNull();
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
        messageId,
        turnId: 'turn-one',
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
      { type: 'subscribe', afterSequence: 0 },
      { type: 'request_snapshot' },
    ]);

    // The answer releases the slot, and the run going terminal is a new reason
    // to ask — so coalescing suppresses repetition without suppressing the
    // reconciliation that matters.
    act(() => socket.message(snapshotFrame({
      sequence: 28,
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
      { type: 'subscribe', afterSequence: 0 },
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
      message: 'Canonical work-stream state is unavailable.',
    }));
    act(() => socket.message({
      type: 'harness_status_changed',
      sequence: 6,
      occurredAt: '2026-07-31T19:20:02.000Z',
      status: 'completed',
    }));
    await flushPromises();

    expect(sentFrames(socket)).toEqual([
      { type: 'subscribe', afterSequence: 0 },
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
    act(() => socket.open());
    act(() => socket.message(snapshotFrame({ sequence: 1, workstream: { id: workstreamId } })));
    await flushPromises();

    const line = debug.mock.calls
      .filter((call) => String(call[0]).startsWith('[perf]'))
      .map((call) => call[1] as { phases: Record<string, number>; sinceEffectMs: number })
      .at(-1)!;
    // `dial` closes on the line that constructs the WebSocket and `handshake`
    // on its open event. Collapsing them back into one number is what made a
    // blocked renderer indistinguishable from a slow connection.
    expect(Object.keys(line.phases)).toEqual(['socket_ticket', 'dial', 'handshake', 'first_frame']);
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

  it('hands a running stream between foreground and background subscribers without gaps or duplicate text', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const frames = stubAnimationFrames();
    const queryClient = new QueryClient();
    const firstWorkstreamId = '00000000-0000-7000-8000-000000000401';
    const secondWorkstreamId = '00000000-0000-7000-8000-000000000402';
    const messageId = '00000000-0000-7000-8000-000000000403';
    const harnessRunId = '00000000-0000-7000-8000-000000000404';
    const api = socketApiWith({
      getSocketTicket: vi.fn(async (workstreamId: string) => ({
        url: `wss://api.rally.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
      getWorkstream: vi.fn(async (workstreamId: string) => workstreamBoot({
        id: workstreamId,
        harnessStatus: 'running',
      })),
      getMessages: vi.fn(async () => []),
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
    expect(firstSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 0 }));
    act(() => firstSocket.message({
      type: 'stream_started',
      sequence: 1,
      occurredAt: '2026-07-31T19:21:00.000Z',
      messageId,
      harnessRunId,
      turnId: 'turn-route-change',
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    act(() => firstSocket.message({
      type: 'stream_delta',
      sequence: 2,
      occurredAt: '2026-07-31T19:21:01.000Z',
      messageId,
      turnId: 'turn-route-change',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'One',
    }));

    rendered.rerender(<Tree view="away" />);
    await flushPromises();
    const backgroundSocket = latestSocketFor(firstWorkstreamId);
    act(() => backgroundSocket.open());
    expect(backgroundSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 2 }));
    // A retried Bind frame can occupy a new room sequence. The stream cursor
    // crossing the component handoff must reject it before the next real chunk.
    act(() => backgroundSocket.message({
      type: 'stream_delta',
      sequence: 3,
      occurredAt: '2026-07-31T19:21:02.000Z',
      messageId,
      turnId: 'turn-route-change',
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: 'One',
    }));
    act(() => backgroundSocket.message({
      type: 'stream_delta',
      sequence: 4,
      occurredAt: '2026-07-31T19:21:03.000Z',
      messageId,
      turnId: 'turn-route-change',
      epoch: 0,
      streamSeq: 2,
      reset: false,
      delta: ' two',
    }));
    await flushPromises();
    await frames.flush();
    expect(queryClient.getQueryData<Message[]>(['messages', firstWorkstreamId])?.[0]?.text).toBe('One two');

    rendered.rerender(<Tree view="returned" />);
    await flushPromises();
    const returnedSocket = latestSocketFor(firstWorkstreamId);
    act(() => returnedSocket.open());
    expect(returnedSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', afterSequence: 4 }));
    act(() => returnedSocket.message({
      type: 'stream_delta',
      sequence: 5,
      occurredAt: '2026-07-31T19:21:04.000Z',
      messageId,
      turnId: 'turn-route-change',
      epoch: 0,
      streamSeq: 3,
      reset: false,
      delta: ' three',
    }));
    await frames.flush();
    expect(queryClient.getQueryData<Message[]>(['messages', firstWorkstreamId])?.[0]?.text).toBe('One two three');
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
    const getSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/workstreams/workstream-one',
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
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
    const api = socketApiWith({
      getSocketTicket,
      getWorkstream: vi.fn(async () => workstreamBoot({ id: 'workstream-one' })),
      getMessages: vi.fn(async () => []),
    });
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

  it('counts one drop when a resync frame lands in the same batch as an abrupt close', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const getSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/workstreams/workstream-one',
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({
      getSocketTicket,
      getWorkstream: vi.fn(async () => workstreamBoot({ id: 'workstream-one' })),
      getMessages: vi.fn(async () => []),
    });
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
    const getSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/workstreams/workstream-one',
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    }));
    const api = socketApiWith({ getSocketTicket });
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
    const frames = stubAnimationFrames();
    const queryClient = new QueryClient();
    const messageId = '00000000-0000-7000-8000-000000000501';
    const harnessRunId = '00000000-0000-7000-8000-000000000502';
    queryClient.setQueryData(['workstream', 'workstream-one'], {
      id: 'workstream-one',
      title: 'Stale',
      harnessStatus: 'completed',
      latestHarnessRunId: '00000000-0000-7000-8000-000000000503',
    });
    queryClient.setQueryData(['messages', 'workstream-one'], []);
    const laterPage = workstreamSummary({
      id: '00000000-0000-7000-8000-000000000504',
      title: 'Later page',
    });
    const debugRow = workstreamSummary({
      id: '00000000-0000-7000-8000-000000000505',
      title: 'System row',
      systemKind: 'digest',
    });
    setCachedWorkstreams(queryClient, [
      workstreamSummary({ id: 'workstream-one', title: 'Stale' }),
      laterPage,
      debugRow,
    ]);
    const getSocketTicket = vi.fn(async () => ({
      url: 'wss://api.rally.test/workstreams/workstream-one',
      ticket: 'socket-ticket', protocols: socketTicketProtocols('socket-ticket'),
    }));
    const canonicalWorkstream = workstreamBoot({
      id: 'workstream-one',
      title: 'Canonical',
      harnessStatus: 'running',
      latestHarnessRunId: harnessRunId,
    });
    const getWorkstream = vi.fn(async () => canonicalWorkstream);
    const getMessages = vi.fn()
      .mockRejectedValueOnce(new Error('transient D1 failure'))
      .mockResolvedValueOnce([]);
    const api = socketApiWith({
      getSocketTicket,
      getWorkstream,
      getMessages,
    });
    const { result } = renderHook(() => useWorkstreamSocket(api, 'workstream-one', true), {
      wrapper: createWrapper(queryClient),
    });

    await flushPromises();
    act(() => FakeWebSocket.instances[0]?.open());
    act(() => FakeWebSocket.instances[0]?.message({
      type: 'resync_required',
      sequence: 14,
      latestSequence: 14,
      occurredAt: '2026-07-31T20:00:00.000Z',
      reason: 'history_unavailable',
      activeStreams: [{
        messageId,
        harnessRunId,
        turnId: 'turn-resync',
        epoch: 0,
        streamSeq: 2,
        seenTurnIds: ['turn-resync'],
        text: 'Recovered partial',
        turnStartOffset: 0,
        roomSequence: 14,
        createdAt: '2026-07-31T19:59:59.000Z',
      }],
      activeCompaction: {
        harnessRunId,
        attemptId: '00000000-0000-7000-8000-000000000504',
        compactionIndex: 2,
        trigger: 'auto',
        startedAt: '2026-07-31T19:59:58.000Z',
      },
    }));
    expect(result.current.activeCompaction).toMatchObject({ harnessRunId, compactionIndex: 2 });

    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(getMessages).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(queryClient.getQueryData<{ title: string }>(['workstream', 'workstream-one'])?.title).toBe('Stale');
    expect(queryClient.getQueryData<Message[]>(['messages', 'workstream-one'])?.[0]?.text)
      .toBe('Recovered partial');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1]?.open());
    expect(FakeWebSocket.instances[1]?.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', afterSequence: 14 }),
    );
    expect(queryClient.getQueryData<{ title: string }>(['workstream', 'workstream-one'])?.title).toBe('Canonical');
    expect(queryClient.getQueryData(['workstreams'])).toEqual([
      workstreamSummary({ id: 'workstream-one', title: 'Stale' }),
      laterPage,
      debugRow,
    ]);
    expect(queryClient.getQueryState(['workstreams'])?.isInvalidated).toBe(true);
    act(() => FakeWebSocket.instances[1]?.message({
      type: 'harness_status_changed',
      sequence: 15,
      occurredAt: '2026-07-31T20:00:01.000Z',
      status: 'completed',
    }));
    expect(result.current.activeCompaction).toBeNull();
    act(() => FakeWebSocket.instances[1]?.message({
      type: 'stream_delta',
      sequence: 16,
      occurredAt: '2026-07-31T20:00:01.000Z',
      messageId,
      harnessRunId,
      turnId: 'turn-resync',
      epoch: 0,
      streamSeq: 3,
      reset: false,
      delta: ' plus live',
    }));
    await frames.flush();
    expect(queryClient.getQueryData<Message[]>(['messages', 'workstream-one'])?.[0]?.text)
      .toBe('Recovered partial plus live');
  });
});
