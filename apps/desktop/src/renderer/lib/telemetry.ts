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

export function telemetryCountBucket(value: number):
  'zero' | 'one' | 'two_to_five' | 'six_to_twenty' | 'twenty_one_to_one_hundred' | 'over_one_hundred' {
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
