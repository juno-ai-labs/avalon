import type {
  DesktopJavascriptErrorCandidate,
  DesktopTelemetryProductIntent,
  DesktopTelemetryScreen,
} from '../../common/desktop';
import { desktopBridge } from './platform';

const reportedJavascriptErrorPriorities = new WeakMap<Error, number>();
const recentNetworkErrorSignatures = new Map<string, number>();
const networkErrorReportIntervalMs = 5 * 60 * 1_000;
const maximumNetworkErrorSignatures = 100;
const openedWorkstreamIds = new Set<string>();
const openedNoteIds = new Set<string>();
const pendingWorkstreamNavigation = new Map<string, 'opened' | 'switched'>();
export type TelemetrySurfaceEntrypoint =
  | 'direct' | 'sidebar_new' | 'sidebar_pinned' | 'sidebar_recent' | 'sidebar_note' | 'sidebar_automation'
  | 'home_waiting' | 'home_suggested' | 'menu_bar' | 'command_shortcut' | 'deep_link'
  | 'notification' | 'automation_run_list' | 'in_app_link' | 'settings' | 'unknown';
let pendingSurfaceEntrypoint: TelemetrySurfaceEntrypoint = 'direct';
let activeSurfaceEntrypoint: TelemetrySurfaceEntrypoint = 'direct';

export type WorkstreamFeedCacheState = 'feed_cached' | 'detail_cached' | 'cold';
export type WorkstreamFeedSidebarSection = 'pinned' | 'recent';
export type WorkstreamFeedSocketPoolState = 'retained_pair' | 'control_warmup' | 'cold';
export type TelemetryCountBucket =
  'zero' | 'one' | 'two_to_five' | 'six_to_twenty' | 'twenty_one_to_one_hundred' | 'over_one_hundred';
export type WorkstreamSocketStartReason =
  | 'hover_warmup' | 'active_workstream' | 'background_workstream' | 'retained_workstream' | 'reconnect';

interface PendingWorkstreamFeedOpen {
  workstreamId: string;
  operationId: string;
  startedAt: number;
  dataReadyAt?: number;
  sidebarSection: WorkstreamFeedSidebarSection;
  socketPoolState: WorkstreamFeedSocketPoolState;
  socketLeaseId?: string;
  cacheState?: WorkstreamFeedCacheState;
  sendReadyReported?: boolean;
}

let pendingWorkstreamFeedOpen: PendingWorkstreamFeedOpen | null = null;
let visibleWorkstreamOpenAwaitingSendReady: Pick<
  PendingWorkstreamFeedOpen,
  'workstreamId' | 'operationId' | 'startedAt'
> | null = null;

export function markSurfaceEntrypoint(entrypoint: TelemetrySurfaceEntrypoint): void {
  pendingSurfaceEntrypoint = entrypoint;
}

export function consumeSurfaceEntrypoint(): TelemetrySurfaceEntrypoint {
  const entrypoint = pendingSurfaceEntrypoint;
  activeSurfaceEntrypoint = entrypoint;
  pendingSurfaceEntrypoint = 'unknown';
  return entrypoint;
}

export function currentSurfaceEntrypoint(): TelemetrySurfaceEntrypoint {
  return activeSurfaceEntrypoint;
}

export function telemetryCountBucket(value: number): TelemetryCountBucket {
  const count = Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
  if (count === 0) return 'zero';
  if (count === 1) return 'one';
  if (count <= 5) return 'two_to_five';
  if (count <= 20) return 'six_to_twenty';
  if (count <= 100) return 'twenty_one_to_one_hundred';
  return 'over_one_hundred';
}

export function telemetryJourneyDuration(milliseconds: number):
  'lt_1s' | '1s_5s' | '5s_30s' | '30s_2m' | '2m_10m' | 'gte_10m' {
  const duration = Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0);
  if (duration < 1_000) return 'lt_1s';
  if (duration < 5_000) return '1s_5s';
  if (duration < 30_000) return '5s_30s';
  if (duration < 120_000) return '30s_2m';
  if (duration < 600_000) return '2m_10m';
  return 'gte_10m';
}

export function telemetrySurfaceForPath(pathname: string): {
  surface: 'workspace_home' | 'workstream' | 'note_detail' | 'meeting_capture' | 'automation_builder'
    | 'automation_detail' | 'settings_application';
  resourceType?: 'workstream' | 'note' | 'automation';
  resourceId?: string;
} | null {
  if (pathname === '/workstreams/new') return { surface: 'workspace_home' };
  if (pathname === '/meeting') return { surface: 'meeting_capture' };
  if (pathname === '/automations/new') return { surface: 'automation_builder' };
  if (pathname === '/settings') return { surface: 'settings_application' };
  const match = /^\/(workstreams|notes|automations)\/([0-9a-f-]{36})$/iu.exec(pathname);
  if (!match) return null;
  const resourceType = match[1] === 'workstreams' ? 'workstream' : match[1] === 'notes' ? 'note' : 'automation';
  const surface = resourceType === 'workstream' ? 'workstream' : resourceType === 'note' ? 'note_detail' : 'automation_detail';
  return { surface, resourceType, resourceId: match[2] };
}

export function telemetryVisibility(scope: 'personal' | 'workspace' | 'you'): 'private' | 'public' {
  return scope === 'workspace' ? 'public' : 'private';
}

export function markWorkstreamNavigation(workstreamId: string, switched: boolean): void {
  pendingWorkstreamNavigation.set(workstreamId, switched ? 'switched' : 'opened');
}

/**
 * Starts the one sidebar-click flow whose next painted feed is being measured.
 * A duplicate click on the same destination preserves every first-click
 * dimension as well as its clock. The serving lease may be backfilled because
 * a hover warm-up can finish after that click; choosing another row replaces
 * the attempt so a late response cannot be attributed to the wrong interaction.
 */
export function markWorkstreamFeedOpenStarted(
  workstreamId: string,
  sidebarSection: WorkstreamFeedSidebarSection,
  socketPoolState: WorkstreamFeedSocketPoolState,
  startedAt = performance.now(),
  socketLeaseId?: string,
): string {
  if (pendingWorkstreamFeedOpen?.workstreamId === workstreamId) {
    if (socketLeaseId && !pendingWorkstreamFeedOpen.socketLeaseId) {
      pendingWorkstreamFeedOpen.socketLeaseId = socketLeaseId;
    }
    return pendingWorkstreamFeedOpen.operationId;
  }
  if (pendingWorkstreamFeedOpen) {
    const superseded = pendingWorkstreamFeedOpen;
    reportTelemetryProductIntent({
      kind: 'workstream_open_outcome',
      operationId: superseded.operationId,
      workstreamId: superseded.workstreamId,
      outcome: 'superseded',
      durationMs: Math.max(0, Math.round(startedAt - superseded.startedAt)),
      ...(superseded.socketLeaseId ? { socketLeaseId: superseded.socketLeaseId } : {}),
      supersedingWorkstreamId: workstreamId,
    });
  }
  // A painted attempt may still be waiting for its independent composer-ready
  // milestone. A new click owns a new lineage, so its later frame cannot report
  // against the previous click even when A is opened again after A -> B.
  visibleWorkstreamOpenAwaitingSendReady = null;
  const operationId = uuidV7();
  pendingWorkstreamFeedOpen = {
    workstreamId,
    operationId,
    startedAt,
    sidebarSection,
    socketPoolState,
    ...(socketLeaseId ? { socketLeaseId } : {}),
  };
  reportTelemetryProductIntent({
    kind: 'workstream_open_started',
    operationId,
    workstreamId,
    sidebarSection,
    socketPoolState,
    ...(socketLeaseId ? { socketLeaseId } : {}),
  });
  return operationId;
}

export function markWorkstreamFeedCacheState(
  workstreamId: string,
  cacheState: WorkstreamFeedCacheState,
): void {
  if (pendingWorkstreamFeedOpen?.workstreamId === workstreamId
    && pendingWorkstreamFeedOpen.cacheState === undefined) {
    pendingWorkstreamFeedOpen.cacheState = cacheState;
  }
}

export function markWorkstreamFeedSocketLease(workstreamId: string, socketLeaseId?: string): void {
  if (socketLeaseId && pendingWorkstreamFeedOpen?.workstreamId === workstreamId
    && pendingWorkstreamFeedOpen.socketLeaseId === undefined) {
    pendingWorkstreamFeedOpen.socketLeaseId = socketLeaseId;
  }
}

/** The click-scoped operation id carried beside each detail request's own id. */
export function workstreamFeedOpenAttemptId(workstreamId: string): string | undefined {
  return pendingWorkstreamFeedOpen?.workstreamId === workstreamId
    ? pendingWorkstreamFeedOpen.operationId
    : undefined;
}

/** Ends a click whose destination was left without another sidebar click. */
export function abandonPendingWorkstreamFeedOpen(abandonedAt = performance.now()): void {
  const attempt = pendingWorkstreamFeedOpen;
  pendingWorkstreamFeedOpen = null;
  visibleWorkstreamOpenAwaitingSendReady = null;
  if (!attempt) return;
  reportTelemetryProductIntent({
    kind: 'workstream_open_outcome',
    operationId: attempt.operationId,
    workstreamId: attempt.workstreamId,
    outcome: 'abandoned',
    durationMs: Math.max(0, Math.round(abandonedAt - attempt.startedAt)),
    ...(attempt.socketLeaseId ? { socketLeaseId: attempt.socketLeaseId } : {}),
  });
}

/** Route observation is outside WorkstreamScreen so StrictMode cannot mistake
 * its development-only effect cleanup for the reader actually leaving. */
export function abandonWorkstreamFeedOpenOutsideRoute(
  activeWorkstreamId: string | null,
  abandonedAt = performance.now(),
): void {
  if (pendingWorkstreamFeedOpen && pendingWorkstreamFeedOpen.workstreamId !== activeWorkstreamId) {
    abandonPendingWorkstreamFeedOpen(abandonedAt);
  }
  if (visibleWorkstreamOpenAwaitingSendReady?.workstreamId !== activeWorkstreamId) {
    visibleWorkstreamOpenAwaitingSendReady = null;
  }
}

export function workstreamFeedOpenCacheState(
  workstreamId: string,
): WorkstreamFeedCacheState | undefined {
  return pendingWorkstreamFeedOpen?.workstreamId === workstreamId
    ? pendingWorkstreamFeedOpen.cacheState
    : undefined;
}

export function cancelWorkstreamFeedOpen(
  workstreamId: string,
  failedAt = performance.now(),
  socketLeaseId?: string,
): void {
  const attempt = pendingWorkstreamFeedOpen;
  if (attempt?.workstreamId !== workstreamId) return;
  pendingWorkstreamFeedOpen = null;
  visibleWorkstreamOpenAwaitingSendReady = null;
  const resolvedSocketLeaseId = socketLeaseId ?? attempt.socketLeaseId;
  reportTelemetryProductIntent({
    kind: 'workstream_open_outcome',
    operationId: attempt.operationId,
    workstreamId,
    outcome: 'load_failed',
    durationMs: Math.max(0, Math.round(failedAt - attempt.startedAt)),
    ...(resolvedSocketLeaseId ? { socketLeaseId: resolvedSocketLeaseId } : {}),
  });
}

/** Returns true only for the first committed data-ready render in this flow. */
export function markWorkstreamFeedDataReady(workstreamId: string, readyAt = performance.now()): boolean {
  if (pendingWorkstreamFeedOpen?.workstreamId !== workstreamId
    || pendingWorkstreamFeedOpen.dataReadyAt !== undefined) return false;
  pendingWorkstreamFeedOpen.dataReadyAt = Math.max(pendingWorkstreamFeedOpen.startedAt, readyAt);
  return true;
}

export function completeWorkstreamFeedPaint(
  workstreamId: string,
  feedSource: 'feed_cache' | 'socket_snapshot' | 'boot_payload' | 'legacy_page',
  messageCount: ReturnType<typeof telemetryCountBucket>,
  paintedAt = performance.now(),
  socketLeaseId?: string,
): {
  intent: DesktopTelemetryProductIntent;
  operationId: string;
  outcomeIntent: DesktopTelemetryProductIntent;
} | null {
  const attempt = pendingWorkstreamFeedOpen;
  if (attempt?.workstreamId !== workstreamId || attempt.dataReadyAt === undefined
    || attempt.cacheState === undefined) return null;
  pendingWorkstreamFeedOpen = null;
  visibleWorkstreamOpenAwaitingSendReady = attempt.sendReadyReported
    ? null
    : {
      workstreamId: attempt.workstreamId,
      operationId: attempt.operationId,
      startedAt: attempt.startedAt,
    };
  const dataReadyDurationMs = Math.round(attempt.dataReadyAt - attempt.startedAt);
  const durationMs = Math.max(dataReadyDurationMs, Math.round(paintedAt - attempt.startedAt));
  const resolvedSocketLeaseId = socketLeaseId ?? attempt.socketLeaseId;
  return {
    operationId: attempt.operationId,
    intent: {
      kind: 'workstream_feed_visible',
      operationId: attempt.operationId,
      workstreamId,
      ...(resolvedSocketLeaseId ? { socketLeaseId: resolvedSocketLeaseId } : {}),
      durationMs,
      dataReadyDurationMs,
      sidebarSection: attempt.sidebarSection,
      cacheState: attempt.cacheState,
      socketPoolState: attempt.socketPoolState,
      feedSource,
      messageCount,
    },
    outcomeIntent: {
      kind: 'workstream_open_outcome',
      operationId: attempt.operationId,
      workstreamId,
      outcome: 'visible',
      durationMs,
      ...(resolvedSocketLeaseId ? { socketLeaseId: resolvedSocketLeaseId } : {}),
    },
  };
}

export type WorkstreamSendReadyWorkspaceSocketState =
  'connecting' | 'connected' | 'reconnecting';

/** Records the one independent client send-readiness milestone for an opening.
 * A visible feed can win the paint race, so its lineage is retained until this
 * event, another route, or another click settles which attempt owns the frame. */
export function reportWorkstreamSendReady(
  workstreamId: string,
  workspaceSocketState: WorkstreamSendReadyWorkspaceSocketState,
  readyAt = performance.now(),
): boolean {
  const pending = pendingWorkstreamFeedOpen?.workstreamId === workstreamId
    ? pendingWorkstreamFeedOpen
    : null;
  if (pending?.sendReadyReported) return false;
  const attempt = pending ?? (visibleWorkstreamOpenAwaitingSendReady?.workstreamId === workstreamId
    ? visibleWorkstreamOpenAwaitingSendReady
    : null);
  if (!attempt) return false;
  if (pending) pending.sendReadyReported = true;
  else visibleWorkstreamOpenAwaitingSendReady = null;
  reportTelemetryProductIntent({
    kind: 'workstream_send_ready',
    operationId: attempt.operationId,
    workstreamId,
    durationMs: Math.max(0, Math.round(readyAt - attempt.startedAt)),
    workspaceSocketState,
  });
  return true;
}

/** Two frames prove that the composer committed beside an installed send
 * handler has crossed a paint. Cleanup makes StrictMode and state changes
 * reschedule rather than publishing readiness from a discarded effect. */
export function reportWorkstreamSendReadyAfterPaint(
  workstreamId: string,
  workspaceSocketState: WorkstreamSendReadyWorkspaceSocketState,
): () => void {
  let paintedFrame = 0;
  const committedFrame = window.requestAnimationFrame(() => {
    paintedFrame = window.requestAnimationFrame(() => {
      reportWorkstreamSendReady(workstreamId, workspaceSocketState);
    });
  });
  return () => {
    window.cancelAnimationFrame(committedFrame);
    if (paintedFrame !== 0) window.cancelAnimationFrame(paintedFrame);
  };
}

/**
 * A requestAnimationFrame callback runs immediately before a paint. Scheduling
 * the second frame from the first guarantees the committed transcript crossed
 * one paint before the completion event is captured.
 */
export function reportWorkstreamFeedAfterPaint(
  workstreamId: string,
  feedSource: 'feed_cache' | 'socket_snapshot' | 'boot_payload' | 'legacy_page',
  messageCount: ReturnType<typeof telemetryCountBucket>,
  socketLeaseId?: string,
): () => void {
  let paintedFrame = 0;
  const committedFrame = window.requestAnimationFrame(() => {
    paintedFrame = window.requestAnimationFrame(() => {
      const completed = completeWorkstreamFeedPaint(
        workstreamId,
        feedSource,
        messageCount,
        performance.now(),
        socketLeaseId,
      );
      if (completed) {
        reportTelemetryProductIntent(completed.intent);
        reportTelemetryProductIntent(completed.outcomeIntent);
      }
    });
  });
  return () => {
    window.cancelAnimationFrame(committedFrame);
    if (paintedFrame !== 0) window.cancelAnimationFrame(paintedFrame);
  };
}

export function workstreamNavigation(workstreamId: string): 'opened' | 'switched' | 'reopened' {
  const pending = pendingWorkstreamNavigation.get(workstreamId);
  pendingWorkstreamNavigation.delete(workstreamId);
  const seen = openedWorkstreamIds.has(workstreamId);
  openedWorkstreamIds.add(workstreamId);
  if (pending === 'switched') return 'switched';
  return seen ? 'reopened' : 'opened';
}

export function noteNavigation(noteId: string): 'opened' | 'reopened' {
  const seen = openedNoteIds.has(noteId);
  openedNoteIds.add(noteId);
  return seen ? 'reopened' : 'opened';
}

function javascriptErrorPriority(errorCode: DesktopJavascriptErrorCandidate['errorCode']): number {
  return errorCode === 'network_error' ? 0 : 1;
}

function shouldReportNetworkError(candidate: DesktopJavascriptErrorCandidate): boolean {
  if (candidate.errorCode !== 'network_error') return true;
  const signature = candidate.frames.join('\0');
  const now = Date.now();
  const previous = recentNetworkErrorSignatures.get(signature);
  if (previous !== undefined && now - previous < networkErrorReportIntervalMs) return false;
  if (previous !== undefined) {
    recentNetworkErrorSignatures.delete(signature);
  } else if (recentNetworkErrorSignatures.size >= maximumNetworkErrorSignatures) {
    const oldest = recentNetworkErrorSignatures.keys().next().value as string | undefined;
    if (oldest !== undefined) recentNetworkErrorSignatures.delete(oldest);
  }
  recentNetworkErrorSignatures.set(signature, now);
  return true;
}

export function telemetryScreenForPath(pathname: string): DesktopTelemetryScreen | null {
  if (pathname === '/workstreams/new') return 'workspace_home';
  if (/^\/workstreams\/[^/]+$/u.test(pathname)) return 'workstream';
  if (pathname === '/settings') return 'application_settings';
  return null;
}

export function reportTelemetryScreen(screen: DesktopTelemetryScreen): void {
  fireAndForget(() => desktopBridge().reportTelemetryScreen(screen));
}

export function reportTelemetryProductIntent(intent: DesktopTelemetryProductIntent): void {
  fireAndForget(() => desktopBridge().reportTelemetryProductIntent(intent));
}

function fireAndForget(invoke: () => Promise<void>): void {
  try {
    void invoke().catch(() => undefined);
  } catch {
    // Telemetry must never change renderer behavior, including when the
    // preload bridge is unavailable or throws before returning a promise.
  }
}

export function javascriptErrorCandidate(
  error: unknown,
  errorCode: DesktopJavascriptErrorCandidate['errorCode'],
): DesktopJavascriptErrorCandidate | null {
  if (!(error instanceof Error) || !error.stack) return null;
  const frames: string[] = [];
  const pattern = /([^\s()]+\.(?:c?js))(?:[?#][^\s():]*)?:(\d{1,7}):(\d{1,5})/gu;
  for (const match of error.stack.matchAll(pattern)) {
    const generatedPath = match[1]!.replaceAll('\\', '/');
    const file = generatedPath.slice(generatedPath.lastIndexOf('/') + 1);
    if (!file || file.includes('..')) continue;
    frames.push(`${file}:${match[2]}:${match[3]}`);
    if (frames.length === 20) break;
  }
  return frames.length === 0 ? null : { process: 'renderer', errorCode, frames };
}

export function reportJavascriptError(
  error: unknown,
  errorCode: DesktopJavascriptErrorCandidate['errorCode'],
): void {
  if (!(error instanceof Error)) return;
  const priority = javascriptErrorPriority(errorCode);
  const reportedPriority = reportedJavascriptErrorPriorities.get(error);
  if (reportedPriority !== undefined && reportedPriority >= priority) return;
  const candidate = javascriptErrorCandidate(error, errorCode);
  if (!candidate) return;
  if (!shouldReportNetworkError(candidate)) return;
  reportedJavascriptErrorPriorities.set(error, priority);
  fireAndForget(() => desktopBridge().reportJavascriptError(candidate));
}

export function installRendererErrorTelemetry(): () => void {
  const onError = (event: ErrorEvent): void => {
    const error = event.error;
    reportJavascriptError(error, error instanceof TypeError
      ? 'type_error'
      : error instanceof RangeError ? 'range_error' : 'unknown');
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    reportJavascriptError(event.reason, 'unhandled_rejection');
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}

export function uuidV7(milliseconds = Date.now()): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 0xffffffffffff) {
    throw new Error('Invalid UUIDv7 timestamp');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let remaining = milliseconds;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
