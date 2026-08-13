import type {
  DesktopJavascriptErrorCandidate,
  DesktopTelemetryProductIntent,
  DesktopTelemetryScreen,
} from '../../common/desktop';
import { desktopBridge } from './platform';

export function telemetryScreenForPath(pathname: string): DesktopTelemetryScreen | null {
  if (pathname === '/workstreams/new' || pathname === '/') return 'workspace_home';
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
  const candidate = javascriptErrorCandidate(error, errorCode);
  if (candidate) fireAndForget(() => desktopBridge().reportJavascriptError(candidate));
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
