import { logDebug } from '../../common/logger';
import type { DesktopTelemetryRendererPerfFlowIntent } from '../../common/desktop';
import { reportTelemetryProductIntent, telemetryCountBucket, uuidV7 } from './telemetry';

/**
 * Client-side phase timing for the three latency-critical work-stream flows.
 *
 * The renderer is not a Worker, so Cloudflare's automatic tracing does not
 * reach it and there is no span to attach to. This is deliberately *not* an
 * OpenTelemetry client: shipping a browser SDK and an exporter out of the
 * Electron renderer would move telemetry off the main-owned regional path
 * `docs/telemetry.md` requires everything to travel on. It produces one local
 * `console.debug` line and one governed diagnostic event per flow, whose job is to answer the
 * question the server's spans cannot: how much of the wait was the service, and
 * how much was the network, the renderer, or a client waiting on a socket it
 * had already been handed.
 *
 * What makes the two halves joinable is the ids. Each line carries the
 * correlation values the Worker records as span attributes for the same flow —
 * the request id sent as `x-request-id` (`rally.request.id`), the socket
 * ticket id (`rally.socket.ticket_id`), the client message id
 * (`rally.message.client_id`). `docs/performance-tracing.md` holds the flows
 * and the queries.
 *
 * The event is a closed projection of the local line rather than console-log
 * forwarding. Work-stream text, attachment names, raw errors, URLs, and
 * arbitrary annotations never reach it; only timings, bounded counts, and the
 * ids required to join the matching backend work.
 */

export type PerfFlow = 'workstream_create' | 'substream_create' | 'workstream_open' | 'workstream_message_send';

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

/**
 * How long the main thread was unavailable during a flow.
 *
 * A phase duration measured in the renderer is wall clock, and wall clock
 * cannot tell "the server was slow" apart from "we were not in a position to
 * ask". A promise continuation does not run while a long task holds the thread,
 * so a phase that reads three seconds is the same number whether the socket was
 * connecting or the transcript was rendering — and those have opposite fixes.
 * `longtask` entries are what separate them: the browser reports every task
 * over 50 ms, so a slow phase with no long tasks under it is genuinely waiting
 * on something else.
 *
 * One observer for the process rather than one per trace: several work streams
 * hold open traces at once — background subscribers included — and the entries
 * are identical for all of them. The buffer is bounded and keeps only a start
 * and an end. The entry's `attribution` is deliberately dropped: it carries
 * frame and script URLs, and nothing else in this module records anything but
 * counts and ids.
 */
const MAX_RETAINED_LONG_TASKS = 256;
const longTasks: Array<{ start: number; end: number }> = [];
/** Held so the observer is not collected while the renderer is alive. */
let longTaskObserver: PerformanceObserver | null = null;
let longTaskObserverAttempted = false;

function observeLongTasks(): void {
  if (longTaskObserverAttempted) return;
  longTaskObserverAttempted = true;
  // The constructor is absent in jsdom and `observe` rejects the entry type on
  // any runtime that has not shipped it. Both land here, and both are a gap in
  // the diagnosis rather than a broken flow, so neither is allowed out.
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ start: entry.startTime, end: entry.startTime + entry.duration });
        if (longTasks.length > MAX_RETAINED_LONG_TASKS) longTasks.shift();
      }
    });
    longTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {
    longTaskObserver = null;
  }
}

/**
 * Milliseconds of long-task time overlapping a window, and how many tasks
 * contributed. Overlap rather than containment: the task that matters most is
 * usually the one straddling the boundary, and counting it whole would charge a
 * flow for work that ran before it started.
 */
function blockingWithin(from: number, to: number): { blockedMs: number; longTasks: number } {
  let blockedMs = 0;
  let count = 0;
  for (const task of longTasks) {
    const overlap = Math.min(task.end, to) - Math.max(task.start, from);
    if (overlap > 0) {
      blockedMs += overlap;
      count += 1;
    }
  }
  return { blockedMs: round(blockedMs), longTasks: count };
}

const telemetryPhaseNames = {
  create_request: 'createRequestMs',
  prepare_request: 'prepareRequestMs',
  confirm_request: 'confirmRequestMs',
  cache_seed: 'cacheSeedMs',
  socket_ticket: 'socketTicketMs',
  dial: 'dialMs',
  handshake: 'handshakeMs',
  first_frame: 'firstFrameMs',
  resolve_mentions: 'resolveMentionsMs',
  command_round_trip: 'commandRoundTripMs',
} as const;
type TelemetryPhaseProperty = typeof telemetryPhaseNames[keyof typeof telemetryPhaseNames];

function telemetryNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function telemetryOutcome(
  flow: PerfFlow,
  value: unknown,
): DesktopTelemetryRendererPerfFlowIntent['outcome'] {
  if (value === 'snapshot' || value === 'resync_required'
    || value === 'navigation_requested' || value === 'closed' || value === 'failed'
    || value === 'cancelled' || value === 'offline' || value === 'superseded'
    || value === 'unmounted') return value;
  if (flow === 'workstream_open' && typeof value === 'string') return 'replay_event';
  return 'completed';
}

function countBucketOrUndefined(value: unknown): ReturnType<typeof telemetryCountBucket> | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? telemetryCountBucket(value)
    : undefined;
}

export function rendererPerfFlowIntent(
  flow: PerfFlow,
  operationId: string,
  durationMs: number,
  phases: ReadonlyArray<readonly [string, number]>,
  blocking: { blockedMs: number; longTasks: number },
  fields: Record<string, unknown>,
): DesktopTelemetryRendererPerfFlowIntent {
  const phaseProperties: Partial<Record<TelemetryPhaseProperty, number>> = {};
  for (const [phase, phaseDurationMs] of phases) {
    const property = telemetryPhaseNames[phase as keyof typeof telemetryPhaseNames];
    if (property) phaseProperties[property] = phaseDurationMs;
  }
  const workstreamId = typeof fields['workstreamId'] === 'string' ? fields['workstreamId'] : undefined;
  const ticketId = typeof fields['ticketId'] === 'string' ? fields['ticketId'] : undefined;
  const sinceEffectMs = telemetryNumber(fields['sinceEffectMs']);
  const attempts = countBucketOrUndefined(fields['attempt']);
  const participantCount = countBucketOrUndefined(fields['participantCount']);
  const attachmentCount = countBucketOrUndefined(fields['attachmentCount']);
  const mentionCount = countBucketOrUndefined(fields['mentionCount']);
  const messageLength = countBucketOrUndefined(fields['openingMessageLength'] ?? fields['textLength']);
  const messageCount = countBucketOrUndefined(fields['messageCount']);
  const clientMessageId = typeof fields['clientMessageId'] === 'string'
    ? fields['clientMessageId']
    : undefined;
  const pacResolutionMs = telemetryNumber(fields['pacResolutionMs']);
  const dnsMs = telemetryNumber(fields['dnsMs']);
  const tcpMs = telemetryNumber(fields['tcpMs']);
  const tlsMs = telemetryNumber(fields['tlsMs']);
  const edgeUpgradeMs = telemetryNumber(fields['edgeUpgradeMs']);
  const proxyHandshakeMs = telemetryNumber(fields['proxyHandshakeMs']);
  const failedRouteCount = countBucketOrUndefined(fields['failedRouteCount']);
  const systemWaitMs = telemetryNumber(fields['systemWaitMs']);
  return {
    kind: 'renderer_perf_flow',
    operationId,
    flow,
    outcome: telemetryOutcome(flow, fields['outcome']),
    durationMs,
    blockedMs: blocking.blockedMs,
    longTaskCount: telemetryCountBucket(blocking.longTasks),
    ...phaseProperties,
    ...(workstreamId ? { workstreamId } : {}),
    ...(ticketId ? { ticketId } : {}),
    ...(sinceEffectMs !== undefined ? { sinceEffectMs } : {}),
    ...(attempts ? { attempts } : {}),
    ...(participantCount ? { participantCount } : {}),
    ...(attachmentCount ? { attachmentCount } : {}),
    ...(mentionCount ? { mentionCount } : {}),
    ...(messageLength ? { messageLength } : {}),
    ...(messageCount ? { messageCount } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(pacResolutionMs !== undefined ? { pacResolutionMs } : {}),
    ...(dnsMs !== undefined ? { dnsMs } : {}),
    ...(tcpMs !== undefined ? { tcpMs } : {}),
    ...(tlsMs !== undefined ? { tlsMs } : {}),
    ...(edgeUpgradeMs !== undefined ? { edgeUpgradeMs } : {}),
    ...(proxyHandshakeMs !== undefined ? { proxyHandshakeMs } : {}),
    ...(failedRouteCount ? { failedRouteCount } : {}),
    ...(systemWaitMs !== undefined ? { systemWaitMs } : {}),
  };
}

interface PendingCreationReady {
  address: string;
  trace: PerfTrace;
  startedAt: number;
  systemWaitBeforeReady: number;
}
let pendingCreationReady: PendingCreationReady | null = null;

/** Carries a creation clock across navigation to the painted send-ready boundary. */
export function holdCreationTraceUntilSendReady(
  trace: PerfTrace,
  workstreamId: string,
  substreamId = '0',
  systemWaitBeforeReady = 0,
): void {
  pendingCreationReady?.trace.end({ outcome: 'superseded' });
  pendingCreationReady = {
    address: `${workstreamId}:${substreamId}`,
    trace,
    startedAt: now(),
    systemWaitBeforeReady,
  };
}

export function completeCreationTraceAfterPaint(workstreamId: string, substreamId = '0'): void {
  const pending = pendingCreationReady;
  if (!pending || pending.address !== `${workstreamId}:${substreamId}`) return;
  pendingCreationReady = null;
  pending.trace.end({
    outcome: 'completed',
    workstreamId,
    systemWaitMs: round(pending.systemWaitBeforeReady + now() - pending.startedAt),
  });
}

export interface PerfTraceOptions {
  /** Correlates with the Worker: `x-request-id`, a ticket id, a message id. */
  traceId?: string;
  /** UUIDv7 accepted by telemetry when `traceId` is a UUIDv4 product id. */
  operationId?: string;
  /** Keep speculative/background socket timings device-local. */
  report?: boolean;
  workstreamId?: string;
}

export function startPerfTrace(flow: PerfFlow, options: PerfTraceOptions = {}): PerfTrace {
  observeLongTasks();
  const traceId = options.traceId ?? uuidV7();
  const operationId = options.operationId ?? traceId;
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
      const endedAt = now();
      const durationMs = round(endedAt - startedAt);
      const blocking = blockingWithin(startedAt, endedAt);
      const combinedFields = { ...annotations, ...fields };
      logDebug('perf', `${flow} ${durationMs}ms`, {
        flow,
        traceId,
        durationMs,
        phases: Object.fromEntries(phases),
        // Read against the whole flow rather than per phase: the entries are
        // coarse, and what a reader needs first is whether this flow was slow
        // because the thread was busy at all.
        ...blocking,
        ...combinedFields,
      });
      if (options.report !== false) {
        reportTelemetryProductIntent(rendererPerfFlowIntent(
          flow,
          operationId,
          durationMs,
          phases,
          blocking,
          combinedFields,
        ));
      }
    },
  };
}

/**
 * The id the desktop stamps on one HTTP request. The regional Worker accepts it
 * as `x-request-id`, echoes it, and records it on that request's span as
 * `rally.request.id` — so a slow call seen here is one attribute filter away
 * in the trace, rather than a search by timestamp.
 */
export function newRequestId(): string {
  return uuidV7();
}
