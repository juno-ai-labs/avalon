import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestSocketTicket,
  SOCKET_TICKET_REQUEST_TIMEOUT_MS,
} from './socket-ticket-request';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('requestSocketTicket', () => {
  it('reports a ticket timeout while aborting the transport as an ordinary cancellation', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const ticket = requestSocketTicket((signal) => {
      requestSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const rejection = expect(ticket).rejects.toMatchObject({
      code: 'socket_ticket_timeout',
      name: 'SocketTicketRequestTimeoutError',
    });

    await vi.advanceTimersByTimeAsync(SOCKET_TICKET_REQUEST_TIMEOUT_MS);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toMatchObject({ name: 'AbortError' });
  });

  it('does not start a request whose owner was already cancelled', async () => {
    const owner = new AbortController();
    const reason = new DOMException('Owner stopped.', 'AbortError');
    owner.abort(reason);
    const request = vi.fn(async () => 'ticket');

    await expect(requestSocketTicket(request, {
      ownerSignal: owner.signal,
    })).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });

  it('settles on owner cancellation and removes the owner listener', async () => {
    const owner = new AbortController();
    const addEventListener = vi.spyOn(owner.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(owner.signal, 'removeEventListener');
    let requestSignal: AbortSignal | undefined;
    const ticket = requestSocketTicket((signal) => {
      requestSignal = signal;
      return new Promise<never>(() => undefined);
    }, {
      ownerSignal: owner.signal,
      timeoutMs: null,
    });
    const reason = new DOMException('Owner stopped.', 'AbortError');
    const rejection = expect(ticket).rejects.toBe(reason);

    owner.abort(reason);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toMatchObject({ name: 'AbortError' });
    expect(addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeEventListener).toHaveBeenCalledWith(
      'abort',
      addEventListener.mock.calls[0]?.[1],
    );
  });
});
