/**
 * The ticket request is the first step in every realtime connection attempt.
 * It must settle independently of fetch and credential renewal: either of
 * those can remain pending after an abort, and a socket loop that awaits the
 * raw promise keeps its in-flight guard forever and never retries.
 *
 * Ten seconds is the default for persistent socket attempts without a wider
 * owning deadline. A caller whose state machine already owns an escalating
 * whole-open budget can pass that attempt's budget instead, and a short-lived
 * caller can disable the deadline while retaining owner cancellation.
 */
export const SOCKET_TICKET_REQUEST_TIMEOUT_MS = 10_000;

export class SocketTicketRequestTimeoutError extends Error {
  readonly code = 'socket_ticket_timeout';

  constructor() {
    super('The realtime socket ticket request timed out.');
    this.name = 'SocketTicketRequestTimeoutError';
  }
}

export function isSocketTicketRequestTimeoutError(
  error: unknown,
): error is SocketTicketRequestTimeoutError {
  return error instanceof SocketTicketRequestTimeoutError;
}

interface SocketTicketRequestOptions {
  ownerSignal?: AbortSignal;
  timeoutMs?: number | null;
}

/**
 * Run one ticket request under an attempt-local deadline and optional owner
 * cancellation. The abort race is deliberate: aborting fetch does not settle
 * a caller parked behind shared credential renewal, so the wrapper must reject
 * even when the request it asked to stop remains pending underneath it.
 */
export async function requestSocketTicket<T>(
  request: (signal: AbortSignal) => Promise<T>,
  options: SocketTicketRequestOptions = {},
): Promise<T> {
  const { ownerSignal, timeoutMs = SOCKET_TICKET_REQUEST_TIMEOUT_MS } = options;
  ownerSignal?.throwIfAborted();
  const controller = new AbortController();
  let rejectAborted: ((reason: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const abortUnderlyingRequest = (): void => {
    controller.abort(new DOMException('The request was aborted.', 'AbortError'));
  };
  const abortFromOwner = (): void => {
    rejectAborted?.(ownerSignal?.reason);
    abortUnderlyingRequest();
  };
  ownerSignal?.addEventListener('abort', abortFromOwner, { once: true });
  const timeout = timeoutMs === null ? null : window.setTimeout(() => {
    // The owner needs the precise retry cause, while fetch needs an AbortError
    // so expected cancellation does not become a network-error diagnostic.
    rejectAborted?.(new SocketTicketRequestTimeoutError());
    abortUnderlyingRequest();
  }, timeoutMs);

  try {
    return await Promise.race([request(controller.signal), aborted]);
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
    ownerSignal?.removeEventListener('abort', abortFromOwner);
  }
}
