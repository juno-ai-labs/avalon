import { socketTicketProtocols } from '@avalon/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismissedSuggestionIdsQueryKey } from './transcript';
import type { Message, WorkstreamDetail } from './types';
import { type WorkstreamSocketApi, useWorkstreamSocket } from './use-workstream-socket';

const workstreamId = '00000000-0000-7000-8000-000000000210';
const suggestionId = '00000000-0000-7000-8000-000000000211';
const dismissedSuggestionId = '00000000-0000-7000-8000-000000000213';

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  send = vi.fn();

  constructor(readonly url: string | URL) {
    super();
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
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

const wireSuggestion = {
  id: suggestionId,
  activityId: '00000000-0000-7000-8000-000000000212',
  workstreamId,
  title: 'Linear issue update: AVA-10',
  summary: 'The @mention control should search resources rather than connectors.',
  confidence: 0.9,
  reason: 'Matches the work stream objective',
  status: 'pending' as const,
  createdAt: '2026-08-10T22:19:29.657Z',
  resolvedAt: null,
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function pendingMessage(id = suggestionId): Message {
  return {
    id: `suggestion-${id}`,
    workstreamId,
    sequenceNumber: 1,
    authorType: 'system',
    messageType: 'activity_suggestion',
    createdAt: wireSuggestion.createdAt,
    activitySuggestion: {
      id,
      title: wireSuggestion.title,
      source: 'Activity',
      occurredAt: wireSuggestion.createdAt,
      reason: wireSuggestion.reason,
      status: 'pending',
    },
  };
}

function detail(): WorkstreamDetail {
  return {
    id: workstreamId,
    title: 'Create Linear issues for comments',
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
    pinPosition: null,
    lastActivityAt: '2026-08-10T22:19:29.657Z',
    createdAt: '2026-08-10T22:18:23.197Z',
    participants: [],
    viewers: [],
    resources: [],
    connections: [],
    backgroundTasks: [],
    automationRuns: [],
    suggestions: [],
  };
}

describe('activity suggestions over the work-stream socket', () => {
  it('keeps an accepted card in the feed and removes a dismissed one', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], detail());
    const api = {
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.avalon.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
      getMessages: vi.fn(async () => []),
      getWorkstream: vi.fn(async () => detail()),
      getWorkstreams: vi.fn(async () => ({ items: [], nextCursor: null })),
    } satisfies WorkstreamSocketApi;
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
      },
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'activity_suggestion_created',
      sequence: 1,
      occurredAt: '2026-08-10T22:19:29.657Z',
      suggestion: wireSuggestion,
    }));

    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId])?.suggestions)
      .toMatchObject([{ id: suggestionId, status: 'pending' }]);

    act(() => socket.message({
      type: 'activity_suggestion_resolved',
      sequence: 2,
      occurredAt: '2026-08-10T22:21:01.158Z',
      suggestion: { ...wireSuggestion, status: 'accepted', resolvedAt: '2026-08-10T22:21:01.158Z' },
    }));

    // The detail's pending suggestions are the source a rebuilt transcript draws
    // its cards from. Leaving the accepted one there would put the card back in
    // its pending state on the next message fetch, offering buttons whose
    // request the API has already resolved.
    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId])?.suggestions).toEqual([]);
    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])?.map((message) => ({
      id: message.activitySuggestion?.id,
      status: message.activitySuggestion?.status,
    }))).toEqual([{ id: suggestionId, status: 'accepted' }]);

    act(() => socket.message({
      type: 'activity_suggestion_created',
      sequence: 3,
      occurredAt: '2026-08-10T22:22:01.158Z',
      suggestion: { ...wireSuggestion, id: dismissedSuggestionId },
    }));
    act(() => socket.message({
      type: 'activity_suggestion_resolved',
      sequence: 4,
      occurredAt: '2026-08-10T22:22:03.158Z',
      suggestion: {
        ...wireSuggestion,
        id: dismissedSuggestionId,
        status: 'dismissed',
        resolvedAt: '2026-08-10T22:22:03.158Z',
      },
    }));

    expect(queryClient.getQueryData<WorkstreamDetail>(['workstream', workstreamId])?.suggestions).toEqual([]);
    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])?.map((message) => ({
      id: message.activitySuggestion?.id,
      status: message.activitySuggestion?.status,
    }))).toEqual([{ id: suggestionId, status: 'accepted' }]);
    expect(queryClient.getQueryData<readonly string[]>(dismissedSuggestionIdsQueryKey(workstreamId)))
      .toEqual([dismissedSuggestionId]);
  });

  it('does not let an in-flight canonical fetch restore a dismissed suggestion', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const queryClient = new QueryClient();
    const staleMessages = deferred<Message[]>();
    const staleDetail: WorkstreamDetail = {
      ...detail(),
      harnessStatus: 'running',
      suggestions: [pendingMessage().activitySuggestion!],
    };
    queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], staleDetail);
    const getMessages = vi.fn()
      .mockImplementationOnce(() => staleMessages.promise)
      .mockResolvedValueOnce([]);
    const api = {
      getSocketTicket: vi.fn(async () => ({
        url: `wss://api.avalon.test/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        protocols: socketTicketProtocols('socket-ticket'),
      })),
      getWorkstream: vi.fn(async () => staleDetail),
      getMessages,
      getWorkstreams: vi.fn(async () => ({ items: [], nextCursor: null })),
    } satisfies WorkstreamSocketApi;
    renderHook(() => useWorkstreamSocket(api, workstreamId, true), {
      wrapper: function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
      },
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.message({
      type: 'activity_suggestion_created',
      sequence: 1,
      occurredAt: wireSuggestion.createdAt,
      suggestion: wireSuggestion,
    }));
    act(() => socket.message({
      type: 'harness_status_changed',
      sequence: 2,
      occurredAt: '2026-08-10T22:20:00.000Z',
      status: 'running',
    }));
    expect(getMessages).toHaveBeenCalledOnce();

    act(() => socket.message({
      type: 'activity_suggestion_resolved',
      sequence: 3,
      occurredAt: '2026-08-10T22:21:01.158Z',
      suggestion: { ...wireSuggestion, status: 'dismissed', resolvedAt: '2026-08-10T22:21:01.158Z' },
    }));
    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])).toEqual([]);

    await act(async () => {
      staleMessages.resolve([pendingMessage()]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData<Message[]>(['messages', workstreamId])).toEqual([]);
    expect(queryClient.getQueryData<readonly string[]>(dismissedSuggestionIdsQueryKey(workstreamId)))
      .toEqual([suggestionId]);
  });
});
