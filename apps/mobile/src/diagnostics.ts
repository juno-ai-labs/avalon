import { useSyncExternalStore } from 'react';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { File, Paths } from 'expo-file-system';
import { Platform, Share } from 'react-native';

const failureCodes = ['crash_reporting_failed', 'shell_render_failed', 'webview_load_failed', 'webview_process_terminated', 'artifact_load_failed', 'artifact_process_terminated', 'update_check_failed', 'background_registration_failed', 'notification_registration_failed'] as const;
export type FailureCode = typeof failureCodes[number];
const timingMetrics = ['launch_to_dashboard', 'pin_tap_to_artifact', 'artifact_recovery'] as const;
/** Latency the person feels, against the 500 ms target. `launch_to_dashboard`
 * starts when JavaScript starts, so native process start is not included. */
export type TimingMetric = typeof timingMetrics[number];
export type RuntimeStatus = {
  lastFailure?: { code: FailureCode; at: string };
  lastBackgroundSync?: string;
  timings?: Partial<Record<TimingMetric, { ms: number; at: string }>>;
  update: 'idle' | 'checking' | 'ready' | 'current' | 'failed' | 'development';
};
let status: RuntimeStatus = { update: !__DEV__ && Updates.isEnabled ? 'idle' : 'development' };
const listeners = new Set<() => void>();
const file = () => new File(Paths.document, 'mobile-diagnostics.json');

export function setRuntimeStatus(change: Partial<RuntimeStatus>): void {
  status = { ...status, ...change };
  listeners.forEach((listener) => listener());
  // Only fixed status codes and timestamps are stored, never customer content.
  try { file().write(JSON.stringify(status)); } catch { /* Diagnostics cannot block the app. */ }
}
export function recordFailure(code: FailureCode): void {
  setRuntimeStatus({ lastFailure: { code, at: new Date().toISOString() } });
}
export function recordTiming(metric: TimingMetric, ms: number): void {
  setRuntimeStatus({ timings: { ...status.timings, [metric]: { ms: Math.round(ms), at: new Date().toISOString() } } });
}
export function restoreDiagnostics(): void {
  try {
    const saved: unknown = JSON.parse(file().textSync());
    if (saved && typeof saved === 'object' && 'lastBackgroundSync' in saved && typeof saved.lastBackgroundSync === 'string') {
      status = { ...status, lastBackgroundSync: saved.lastBackgroundSync };
    }
    if (saved && typeof saved === 'object' && 'lastFailure' in saved && saved.lastFailure && typeof saved.lastFailure === 'object') {
      const failure = saved.lastFailure;
      if ('code' in failure && 'at' in failure && typeof failure.at === 'string') {
        const code = failureCodes.find((value) => value === failure.code);
        if (code) status = { ...status, lastFailure: { code, at: failure.at } };
      }
    }
    if (saved && typeof saved === 'object' && 'timings' in saved && saved.timings && typeof saved.timings === 'object') {
      const savedTimings: object = saved.timings;
      const timings: RuntimeStatus['timings'] = {};
      for (const metric of timingMetrics) {
        const value: unknown = Reflect.get(savedTimings, metric);
        if (value && typeof value === 'object' && 'ms' in value && typeof value.ms === 'number' && 'at' in value && typeof value.at === 'string') timings[metric] = { ms: value.ms, at: value.at };
      }
      status = { ...status, timings };
    }
  } catch { /* First launch or an unreadable diagnostic file. */ }
}
export function useRuntimeStatus(): RuntimeStatus {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => status);
}
export function diagnosticSummary(): string {
  return JSON.stringify({
    appVersion: Application.nativeApplicationVersion,
    build: Application.nativeBuildVersion,
    platform: Platform.OS, osVersion: Platform.Version,
    channel: Updates.channel, runtime: Updates.runtimeVersion,
    updateId: Updates.updateId, embedded: Updates.isEmbeddedLaunch,
    emergencyLaunch: Updates.isEmergencyLaunch,
    ...status,
  }, null, 2);
}
export async function shareDiagnostics(): Promise<void> {
  await Share.share({ title: 'Rally diagnostics', message: diagnosticSummary() });
}
