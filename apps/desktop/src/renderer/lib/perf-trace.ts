import { logDebug } from '../../common/logger';
import { uuidV7 } from './telemetry';

/**
 * Client-side phase timing for the three latency-critical work-stream flows.
 *
 * The renderer is not a Worker, so Cloudflare's automatic tracing does not
 * reach it and there is no span to attach to. This is deliberately *not* an
 * OpenTelemetry client: shipping a browser SDK and an exporter out of the
 * Electron renderer would move telemetry off the main-owned regional path
 * `docs/telemetry.md` requires everything to travel on. It is a local
 * diagnostic — one `console.debug` line per flow — whose job is to answer the
 * question the server's spans cannot: how much of the wait was the service, and
 * how much was the network, the renderer, or a client waiting on a socket it
 * had already been handed.
 *
 * What makes the two halves joinable is the ids. Each line carries the
 * correlation values the Worker records as span attributes for the same flow —
 * the request id sent as `x-request-id` (`avalon.request.id`), the socket
 * ticket id (`avalon.socket.ticket_id`), the client message id
 * (`avalon.message.client_id`). `docs/performance-tracing.md` holds the flows
 * and the queries.
 *
 * Nothing here is sent anywhere. Work-stream text and attachment names never
 * reach it; only counts and ids.
 */

export type PerfFlow = 'workstream_create' | 'workstream_open' | 'workstream_message_send';

export interface PerfTrace {
  readonly traceId: string;
  /** Closes the open phase and names it. */
  mark(phase: string): void;
  /** Times `run` as one phase, whether it resolves or rejects. */
  step<T>(phase: string, run: () => Promise<T>): Promise<T>;
  /** Adds fields to the line this trace prints. Later calls win. */
  annotate(fields: Record<string, unknown>): void;
  /** Prints the line. Idempotent, so a `finally` may always call it. */
  end(fields?: Record<string, unknown>): void;
}

function now(): number {
  // `performance.now()` is monotonic, so a trace is not distorted by a system
  // clock that steps while a work stream is opening.
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface PerfTraceOptions {
  /** Correlates with the Worker: `x-request-id`, a ticket id, a message id. */
  traceId?: string;
  workstreamId?: string;
}

export function startPerfTrace(flow: PerfFlow, options: PerfTraceOptions = {}): PerfTrace {
  const traceId = options.traceId ?? uuidV7();
  const startedAt = now();
  const phases: Array<[string, number]> = [];
  let cursor = startedAt;
  let annotations: Record<string, unknown> = options.workstreamId
    ? { workstreamId: options.workstreamId }
    : {};
  let ended = false;

  const close = (phase: string): void => {
    const at = now();
    phases.push([phase, round(at - cursor)]);
    cursor = at;
  };

  return {
    traceId,
    mark: close,
    async step<T>(phase: string, run: () => Promise<T>): Promise<T> {
      try {
        return await run();
      } finally {
        // The phase that threw is the one worth reading, so it is closed
        // before the rejection continues.
        close(phase);
      }
    },
    annotate(fields: Record<string, unknown>): void {
      annotations = { ...annotations, ...fields };
    },
    end(fields: Record<string, unknown> = {}): void {
      if (ended) return;
      ended = true;
      const durationMs = round(now() - startedAt);
      logDebug('perf', `${flow} ${durationMs}ms`, {
        flow,
        traceId,
        durationMs,
        phases: Object.fromEntries(phases),
        ...annotations,
        ...fields,
      });
    },
  };
}

/**
 * The id the desktop stamps on one HTTP request. The regional Worker accepts it
 * as `x-request-id`, echoes it, and records it on that request's span as
 * `avalon.request.id` — so a slow call seen here is one attribute filter away
 * in the trace, rather than a search by timestamp.
 */
export function newRequestId(): string {
  return uuidV7();
}
