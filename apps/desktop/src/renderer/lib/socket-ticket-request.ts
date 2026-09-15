/**
 * The ticket request is the first step in every realtime connection attempt.
 * It must settle independently of fetch and credential renewal: either of
 * those can remain pending after an abort, and a socket loop that awaits the
 * raw promise keeps its in-flight guard forever and never retries.
 *
 * Ten seconds is the existing first-attempt work-stream opening budget. This
 * primitive applies that already-chosen budget to the ticket step of every
 * socket attempt rather than introducing another defensive limit.
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

/**
 * Run one ticket request under an attempt-local deadline and optional owner
 * cancellation. The abort race is deliberate: aborting fetch does not settle
 * a caller parked behind shared credential renewal, so the wrapper must reject
 * even when the request it asked to stop remains pending underneath it.
 */
export async function requestSocketTicket<T>(
  request: (signal: AbortSignal) => Promise<T>,
  ownerSignal?: AbortSignal,
): Promise<T> {
  ownerSignal?.throwIfAborted();
  const controller = new AbortController();
  const abortFromOwner = (): void => controller.abort(ownerSignal?.reason);
  ownerSignal?.addEventListener('abort', abortFromOwner, { once: true });
  const timeout = window.setTimeout(() => {
    controller.abort(new SocketTicketRequestTimeoutError());
  }, SOCKET_TICKET_REQUEST_TIMEOUT_MS);

  let rejectAborted: ((reason: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => {
    rejectAborted?.(controller.signal.reason ?? new DOMException('The request was aborted.', 'AbortError'));
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });

  try {
    return await Promise.race([request(controller.signal), aborted]);
  } finally {
    window.clearTimeout(timeout);
    controller.signal.removeEventListener('abort', onAbort);
    ownerSignal?.removeEventListener('abort', abortFromOwner);
  }
}
