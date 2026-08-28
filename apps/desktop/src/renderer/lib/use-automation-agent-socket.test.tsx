import { AutomationAgentSnapshotSchema, type AutomationAgentSnapshot } from '@rally/contracts';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutomationSummary } from './types';
import { useAutomationAgentSocket } from './use-automation-agent-socket';

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

  frame(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  text(value: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: value }));
  }
}

const automationId = '00000000-0000-7000-8000-000000000001';
const otherAutomationId = '00000000-0000-7000-8000-000000000002';
const workspaceId = '00000000-0000-7000-8000-000000000003';
const userId = '00000000-0000-7000-8000-000000000004';
const turnId = '00000000-0000-7000-8000-000000000005';
const runId = '00000000-0000-7000-8000-000000000006';

function snapshot(overrides: Record<string, unknown> = {}): AutomationAgentSnapshot {
  return AutomationAgentSnapshotSchema.parse({
    schemaVersion: 1,
    automationId,
    workspaceId,
    authorUserId: userId,
    region: 'global',
    lifecycle: 'draft',
    authorityGeneration: 1,
    title: 'New automation',
    definitionRevision: 0,
    definition: null,
    messages: [],
    activeCompilerRun: null,
    compilerCheckpoint: null,
    pendingElicitation: null,
    eventSequence: 1,
    ...overrides,
  });
}

const runningRun = {
  id: runId,
  state: 'running' as const,
  admittedTurnId: turnId,
  errorCode: null,
  errorMessage: null,
};

function ticket() {
  return {
    url: `wss://api.rally.test/socket/automations/${automationId}`,
    ticket: 'automation-ticket',
    protocols: socketTicketProtocols('automation-ticket'),
  };
}

function wrapper(queryClient: QueryClient): ({ children }: PropsWithChildren) => React.JSX.Element {
  return function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function streamFrame(eventSequence: number, event: Record<string, unknown>) {
  return { type: 'event', eventSequence, eventType: 'compiler_stream', payload: { runId, event } };
}

beforeEach(() => {
  // The hook reads both, and a test that depended on either would
  // pass or fail with the machine it ran on rather than the code.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe('useAutomationAgentSocket', () => {
  it('closes a socket serving another automation and applies nothing it sent', async () => {
    vi.useFakeTimers();
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<never>(() => undefined)),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      () => useAutomationAgentSocket(api, automationId),
      { wrapper: wrapper(new QueryClient()) },
    );
    await act(async () => Promise.resolve());
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    act(() => socket.frame({
      type: 'snapshot',
      snapshot: snapshot({ automationId: otherAutomationId, title: 'Somebody else’s draft' }),
    }));

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(rendered.result.current.snapshot).toBeNull();
    expect(rendered.result.current.state).toBe('unavailable');
    // And it does not come back: the same ticket would only serve
    // the same wrong automation again.
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    rendered.unmount();
  });

  it('clears the previous draft’s state the moment the subject changes', async () => {
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<never>(() => undefined)),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      ({ id }: { id: string }) => useAutomationAgentSocket(api, id),
      { initialProps: { id: automationId }, wrapper: wrapper(new QueryClient()) },
    );
    await act(async () => Promise.resolve());
    act(() => FakeWebSocket.instances[0]!.open());
    act(() => FakeWebSocket.instances[0]!.frame({
      type: 'snapshot',
      snapshot: snapshot({ title: 'Watch my blog', activeCompilerRun: runningRun }),
    }));
    act(() => FakeWebSocket.instances[0]!.frame(streamFrame(2, { type: 'delta', delta: 'Reading the blog.' })));
    expect(rendered.result.current.snapshot?.title).toBe('Watch my blog');
    expect(rendered.result.current.narration).toBe('Reading the blog.');

    rendered.rerender({ id: otherAutomationId });

    // Not after the new draft's read resolves — now. A surviving
    // snapshot is what let the builder show a blank slate for a
    // highlighted draft, and admit a send with no automation id.
    expect(rendered.result.current.snapshot).toBeNull();
    expect(rendered.result.current.narration).toBe('');
    expect(rendered.result.current.streamEvents).toEqual([]);
    expect(rendered.result.current.connected).toBe(false);
    rendered.unmount();
  });

  it('carries the agent’s own sequence, so a new subject neither replays nor drops', async () => {
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<never>(() => undefined)),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      ({ id }: { id: string }) => useAutomationAgentSocket(api, id),
      { initialProps: { id: automationId }, wrapper: wrapper(new QueryClient()) },
    );
    await act(async () => Promise.resolve());
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    // A long conversation, so the previous draft's event log is
    // far ahead of a counter that restarts with the effect.
    act(() => first.frame(streamFrame(400, { type: 'delta', delta: 'Oldsummarizing.' })));
    act(() => first.frame(streamFrame(401, {
      type: 'tool', toolCallId: 'tool-old', name: 'Old tool', summary: 'Old', status: 'completed',
    })));
    expect(rendered.result.current.streamEvents).toHaveLength(1);

    rendered.rerender({ id: otherAutomationId });
    await act(async () => Promise.resolve());
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());

    // The new draft's first frames are low-numbered. A local
    // high-water mark would have dropped every one of them.
    act(() => second.frame({ type: 'event', eventSequence: 2, eventType: 'compiler_stream', payload: { runId, event: { type: 'delta', delta: 'New draft.' } } }));
    act(() => second.frame({
      type: 'event',
      eventSequence: 3,
      eventType: 'compiler_stream',
      payload: {
        runId,
        event: { type: 'tool', toolCallId: 'tool-new', name: 'New tool', summary: 'New', status: 'started' },
      },
    }));

    expect(rendered.result.current.narration).toBe('New draft.');
    expect(rendered.result.current.streamEvents).toEqual([
      { sequence: 3, event: expect.objectContaining({ toolCallId: 'tool-new' }) },
    ]);
    rendered.unmount();
  });

  it('drops a snapshot the event log has already overtaken', async () => {
    const queryClient = new QueryClient();
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<never>(() => undefined)),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      () => useAutomationAgentSocket(api, automationId),
      { wrapper: wrapper(queryClient) },
    );
    await act(async () => Promise.resolve());
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.frame({
      type: 'snapshot',
      snapshot: snapshot({ eventSequence: 9, title: 'Newest' }),
    }));

    // An older read, resolving after a newer one. Two refreshes can
    // land in either order, and the loser must change nothing.
    act(() => socket.frame({
      type: 'snapshot',
      snapshot: snapshot({ eventSequence: 4, title: 'Older' }),
    }));

    expect(rendered.result.current.snapshot?.title).toBe('Newest');
    expect(queryClient.getQueryData<AutomationAgentSnapshot>(['automation-draft', automationId])?.title)
      .toBe('Newest');
    rendered.unmount();
  });

  it('writes the draft and its sidebar row together', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AutomationSummary[]>(['automations'], [{
      id: automationId,
      name: 'New automation',
      scope: 'you',
      status: 'draft',
      updatedAt: '2026-08-01T09:00:00.000Z',
    }]);
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<never>(() => undefined)),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      () => useAutomationAgentSocket(api, automationId),
      { wrapper: wrapper(queryClient) },
    );
    await act(async () => Promise.resolve());
    act(() => FakeWebSocket.instances[0]!.open());

    act(() => FakeWebSocket.instances[0]!.frame({
      type: 'snapshot',
      snapshot: snapshot({ eventSequence: 3, title: 'Watch my blog' }),
    }));

    // Both, in one update. The sidebar reads the list and the
    // builder reads the draft, so a frame that renames a draft has
    // to reach both or the row says "New automation" for good.
    expect(queryClient.getQueryData<AutomationAgentSnapshot>(['automation-draft', automationId])?.title)
      .toBe('Watch my blog');
    expect(queryClient.getQueryData<AutomationSummary[]>(['automations'])?.[0])
      .toMatchObject({ name: 'Watch my blog', status: 'draft' });
    rendered.unmount();
  });

  it('reads the agent once for a burst of durable events', async () => {
    const queryClient = new QueryClient();
    let resolveRead!: (value: AutomationAgentSnapshot) => void;
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<AutomationAgentSnapshot>((resolve) => {
        resolveRead = resolve;
      })),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      () => useAutomationAgentSocket(api, automationId),
      { wrapper: wrapper(queryClient) },
    );
    await act(async () => Promise.resolve());
    // The opening read, still in flight.
    expect(api.getAutomationAgentDraft).toHaveBeenCalledTimes(1);
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    act(() => socket.frame({ type: 'event', eventSequence: 2, eventType: 'compiler_admitted', payload: {} }));
    act(() => socket.frame({ type: 'event', eventSequence: 3, eventType: 'compiler_settled', payload: {} }));
    act(() => socket.frame({ type: 'event', eventSequence: 4, eventType: 'definition_updated', payload: {} }));

    // Three events, no second request while the first is open:
    // concurrent reads resolve in either order, and an older
    // snapshot landing last overwrites a newer one.
    expect(api.getAutomationAgentDraft).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveRead(snapshot({ eventSequence: 4 }));
      await Promise.resolve();
    });
    // One more, for the events that arrived while it was open.
    expect(api.getAutomationAgentDraft).toHaveBeenCalledTimes(2);
    rendered.unmount();
  });

  it('ignores a frame it cannot read rather than closing on it', async () => {
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<never>(() => undefined)),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      () => useAutomationAgentSocket(api, automationId),
      { wrapper: wrapper(new QueryClient()) },
    );
    await act(async () => Promise.resolve());
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.frame({
      type: 'snapshot',
      snapshot: snapshot({ eventSequence: 2, title: 'Watch my blog' }),
    }));

    act(() => socket.text('{not jsonON'));
    act(() => socket.frame({ type: 'snapshot', snapshot: { schemaVersion: 1, nonsense: true } }));
    act(() => socket.frame(streamFrame(3, { type: 'delta', delta: null })));

    // Closing here would mint a fresh ticket and reconnect on
    // every malformed frame, which is a loop rather than a repair.
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(rendered.result.current.state).toBe('connected');
    expect(rendered.result.current.snapshot?.title).toBe('Watch my blog');
    rendered.unmount();
  });

  it('pings/pongs, and closes a connection that has gone silent', async () => {
    vi.useFakeTimers();
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<never>(() => undefined)),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      () => useAutomationAgentSocket(api, automationId),
      { wrapper: wrapper(new QueryClient()) },
    );
    await act(async () => Promise.resolve());
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    await act(async () => vi.advanceTimersByTimeAsync(45_000));
    expect(socket.send).toHaveBeenCalledWith('ping');
    act(() => socket.text('pong'));
    await act(async () => vi.advanceTimersByTimeAsync(45_000));
    expect(socket.send.mock.calls.filter(([message]) => message === 'ping')).toHaveLength(2);

    // No pong this time. A half-open socket otherwise leaves a
    // running compile running forever with a disabled composer.
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(rendered.result.current.state).toBe('reconnecting');
    rendered.unmount();
  });

  it('backs off a socket the server keeps dropping instead of retrying at the floor', async () => {
    vi.useFakeTimers();
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<never>(() => undefined)),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      () => useAutomationAgentSocket(api, automationId),
      { wrapper: wrapper(new QueryClient()) },
    );
    await act(async () => Promise.resolve());
    act(() => FakeWebSocket.instances[0]!.open());
    act(() => FakeWebSocket.instances[0]!.close());

    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1]!.open());
    act(() => FakeWebSocket.instances[1]!.close());

    // The counter resets after a stability window, not on `open`.
    // A socket accepted and immediately closed would otherwise
    // reconnect at the floor delay forever.
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(FakeWebSocket.instances).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(FakeWebSocket.instances).toHaveLength(3);
    rendered.unmount();
  });

  it('leaves a live connection alone when a replaced socket closes late', async () => {
    vi.useFakeTimers();
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<never>(() => undefined)),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      () => useAutomationAgentSocket(api, automationId),
      { wrapper: wrapper(new QueryClient()) },
    );
    await act(async () => Promise.resolve());
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.close());
    await act(async () => vi.advanceTimersByTimeAsync(750));
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    expect(rendered.result.current.state).toBe('connected');

    // A close delivered for the socket this loop already replaced.
    act(() => first.dispatchEvent(Object.assign(new Event('close'), { code: 1006 })));

    expect(rendered.result.current.state).toBe('connected');
    expect(rendered.result.current.connected).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    rendered.unmount();
  });

  it('clears a pending reconnect on unmount', async () => {
    vi.useFakeTimers();
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<never>(() => undefined)),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      () => useAutomationAgentSocket(api, automationId),
      { wrapper: wrapper(new QueryClient()) },
    );
    await act(async () => Promise.resolve());
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    // The heartbeat and stability timers are both armed here.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    // And a reconnect timer, which no close can clear because
    // the socket it belongs to is already gone.
    act(() => socket.close());
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    rendered.unmount();

    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('leaves an open socket’s timers behind on unmount either', async () => {
    vi.useFakeTimers();
    const api = {
      getAutomationAgentDraft: vi.fn(() => new Promise<never>(() => undefined)),
      getAutomationAgentSocketTicket: vi.fn(async () => ticket()),
    };
    const rendered = renderHook(
      () => useAutomationAgentSocket(api, automationId),
      { wrapper: wrapper(new QueryClient()) },
    );
    await act(async () => Promise.resolve());
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    rendered.unmount();

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(vi.getTimerCount()).toBe(0);
  });
});
