import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkRecoveryInbox } from '../../common/network-recovery';
import { NetworkRecovery } from '../../main/network-recovery';
import { RallyApi } from './api';
import { SocketTicketRequestTimeoutError, SOCKET_TICKET_REQUEST_TIMEOUT_MS } from './socket-ticket-request';

const channel = '00000000-0000-7000-8000-000000000001';
const target = `/conversations/${channel}/substreams/0/socket`;
const wireTicket = { url: `wss://api.rally.test/socket/conversations/${channel}/0`, ticket: 'fixture-ticket' };

function harness(closeConnections: () => Promise<void>) {
  const inbox = new NetworkRecoveryInbox();
  const record = vi.fn();
  const recovery = new NetworkRecovery({ closeConnections, publish: (state) => inbox.receive(state), record });
  window.rally = {
    getNetworkRecoveryState: () => inbox.state,
    onNetworkRecoveryState: (listener) => inbox.subscribe(listener),
    reportNetworkTicket: async (observation) => { recovery.observe(observation); inbox.receive(recovery.state); },
  } as NonNullable<typeof window.rally>;
  return { recovery, record, api: new RallyApi('https://api.rally.test', null) };
}

afterEach(() => {
  delete window.rally;
  vi.useRealTimers();
});

describe('ticket timeout to shared network recovery integration', () => {
  it('recovers a stranded ticket, including the owning opening deadline, without reloading', async () => {
    vi.useFakeTimers();
    let usable = false;
    const closeConnections = vi.fn(async () => { usable = true; });
    const { api, recovery, record } = harness(closeConnections);
    const fetchRequest = vi.fn(() => usable
      ? Promise.resolve(Response.json(wireTicket)) : new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchRequest);
    const first = expect(api.getSocketTicket(channel)).rejects.toMatchObject({ code: 'socket_ticket_timeout' });
    await vi.advanceTimersByTimeAsync(SOCKET_TICKET_REQUEST_TIMEOUT_MS);
    await first;
    expect(closeConnections).not.toHaveBeenCalled();
    // The whole-open deadline starts before the request-local timer in the
    // real feed hook. Its reason must reach this same escalation path.
    const owner = new AbortController();
    window.setTimeout(() => owner.abort(new SocketTicketRequestTimeoutError()), SOCKET_TICKET_REQUEST_TIMEOUT_MS);
    const second = expect(api.getSocketTicket(channel, '0', undefined, undefined, false, owner.signal))
      .rejects.toMatchObject({ code: 'socket_ticket_timeout' });
    await vi.advanceTimersByTimeAsync(SOCKET_TICKET_REQUEST_TIMEOUT_MS);
    await second;
    expect(closeConnections).toHaveBeenCalledTimes(1);
    const ticket = await api.getSocketTicket(channel);
    expect(ticket.url).toBe(`wss://api.rally.test/socket/conversations/${channel}/0`);
    expect(recovery.state.phase).toBe('awaiting_live');
    api.confirmSocketTicket(ticket);
    expect(recovery.state).toEqual({ generation: 1, phase: 'idle' });
    expect(record).toHaveBeenCalledWith({ kind: 'desktop_network_recovery', generation: 1, phase: 'live_restored' });
  });

  it('holds new requests across API clients and still lets their owners cancel', async () => {
    const reset = Promise.withResolvers<void>();
    const { api, recovery } = harness(() => reset.promise);
    recovery.observe({ generation: 0, target, outcome: 'timeout' });
    recovery.observe({ generation: 0, target, outcome: 'timeout' });
    const fetchRequest = vi.fn(async () => Response.json(wireTicket));
    vi.stubGlobal('fetch', fetchRequest);
    const secondApi = new RallyApi('https://api.rally.test', null);
    const waiting = api.getSocketTicket(channel);
    const owner = new AbortController();
    const cancelled = expect(secondApi.getSocketTicket(channel, '0', undefined, undefined, false, owner.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    owner.abort();
    await cancelled;
    expect(fetchRequest).not.toHaveBeenCalled();
    reset.resolve();
    await waiting;
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it('waits for a new window’s initial state before starting a mutation', async () => {
    const { api } = harness(async () => undefined);
    const ready = Promise.withResolvers<void>();
    window.rally!.waitForNetworkRecoveryState = () => ready.promise;
    const fetchRequest = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchRequest);
    const mutation = api.deleteDraftResource(channel);
    await Promise.resolve();
    expect(fetchRequest).not.toHaveBeenCalled();
    ready.resolve();
    await mutation;
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps streaming response cancellation linked after headers arrive', async () => {
    const { api } = harness(async () => undefined);
    const owner = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        },
      });
      return new Response(body, { headers: { 'content-type': 'audio/pcm;rate=24000;channels=1;bits=16;endian=little' } });
    }));
    const body = await api.streamMessageSpeech('Read this', owner.signal);
    const reading = expect(body.getReader().read()).rejects.toMatchObject({ name: 'AbortError' });
    owner.abort();
    await reading;
  });

  it('abandons old requests even when reset IPC arrives after the native reset', async () => {
    const inbox = new NetworkRecoveryInbox();
    const broadcasts: Array<typeof inbox.state> = [];
    const closeConnections = vi.fn(async () => undefined);
    const recovery = new NetworkRecovery({ closeConnections, publish: (state) => broadcasts.push(state), record: vi.fn() });
    window.rally = {
      getNetworkRecoveryState: () => inbox.state,
      onNetworkRecoveryState: (listener) => inbox.subscribe(listener),
    } as NonNullable<typeof window.rally>;
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal?.reason)));
    }));
    const pending = expect(new RallyApi('https://api.rally.test', null).deleteDraftResource(channel))
      .rejects.toMatchObject({ name: 'AbortError' });
    recovery.observe({ generation: 0, target, outcome: 'timeout' });
    recovery.observe({ generation: 0, target, outcome: 'timeout' });
    await Promise.resolve();
    expect(closeConnections).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    for (const state of broadcasts) inbox.receive(state);
    await pending;
    expect(signal?.aborted).toBe(true);
  });

  it('does not reset for HTTP rejections, ordinary cancellation, or offline ticket timeouts', async () => {
    vi.useFakeTimers();
    const closeConnections = vi.fn(async () => undefined);
    const { api } = harness(closeConnections);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'forbidden', message: 'No access' } }, { status: 403 })));
    await expect(api.getSocketTicket(channel)).rejects.toMatchObject({ status: 403 });
    await expect(api.getSocketTicket(channel)).rejects.toMatchObject({ status: 403 });
    const owner = new AbortController();
    owner.abort();
    await expect(api.getSocketTicket(channel, '0', undefined, undefined, false, owner.signal)).rejects.toMatchObject({ name: 'AbortError' });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    for (let attempt = 0; attempt < 2; attempt++) {
      const timeout = expect(api.getSocketTicket(channel)).rejects.toMatchObject({ code: 'socket_ticket_timeout' });
      await vi.advanceTimersByTimeAsync(SOCKET_TICKET_REQUEST_TIMEOUT_MS);
      await timeout;
    }
    expect(closeConnections).not.toHaveBeenCalled();
  });

  it('does not replay a mutation interrupted by the shared connection reset', async () => {
    const { api, recovery } = harness(async () => undefined);
    let requestSignal: AbortSignal | null | undefined;
    const fetchRequest = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchRequest);
    const interrupted = expect(api.deleteDraftResource(channel)).rejects.toMatchObject({ name: 'AbortError' });
    recovery.observe({ generation: 0, target, outcome: 'timeout' });
    recovery.observe({ generation: 0, target, outcome: 'timeout' });
    expect(requestSignal?.aborted).toBe(true);
    await interrupted;
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(fetchRequest.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });
});
