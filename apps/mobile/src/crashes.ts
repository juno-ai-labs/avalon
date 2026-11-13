import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';
import { MobileCrashScopeSchema, MobileCrashReportSchema, type MobileCrashScope } from '@rally/contracts/crash-reports';
import NativeCrashes from '../modules/rally-crash-reporter/src/RallyCrashReporterModule';
import type { MobileCommand, MobileEvent, MobileSnapshot } from './protocol';
import { recordFailure } from './diagnostics';

export function captureJavascriptCrash(error: unknown, fatal: boolean): void {
  if (!(error instanceof Error) || !NativeCrashes) return;
  try {
    NativeCrashes.captureJavascript(JSON.stringify({ kind: 'hermes', report: error.stack ?? '', fatal, updateId: Updates.updateId }));
  } catch { /* Crash reporting must preserve React Native's normal recovery. */ }
}

export function installCrashHandler(): void {
  if (!NativeCrashes) return;
  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, fatal) => {
    try { if (fatal) captureJavascriptCrash(error, true); }
    finally { previous(error, fatal); }
  });
}

export function clearCrashContext(): void {
  try { NativeCrashes?.configure(null); } catch { /* Telemetry cannot block sign-out. */ }
}

function matches(scope: MobileCrashScope, snapshot: MobileSnapshot | null): boolean {
  return scope.userId === snapshot?.userId && scope.workspaceId === snapshot.workspaceId
    && snapshot.workspacePath === `/app/workspaces/${scope.route}/${scope.workspaceId}`;
}

export function useCrashReporting(directory: MobileSnapshot | null, send: (command: MobileCommand) => void) {
  const latest = useRef(directory); latest.current = directory;
  const approved = useRef<MobileCrashScope | null>(null);
  const pending = useRef(new Set<string>());
  const clear = useCallback(() => {
    approved.current = null; pending.current.clear();
    clearCrashContext();
  }, []);
  useEffect(() => {
    if (approved.current && !matches(approved.current, directory)) clear();
    if (directory && NativeCrashes) {
      const scope = MobileCrashScopeSchema.safeParse({ userId: directory.userId, workspaceId: directory.workspaceId, route: directory.workspacePath.split('/')[3] });
      if (scope.success) { try { NativeCrashes.prepare(scope.data); } catch { clear(); } }
    }
    const verify = () => { if (!__DEV__ && latest.current && NativeCrashes) send({ type: 'crash-status' }); };
    verify();
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') { approved.current = null; pending.current.clear(); verify(); }
    });
    return () => listener.remove();
  }, [directory?.userId, directory?.workspaceId, send, clear]);
  return useCallback((event: MobileEvent) => {
    if (!NativeCrashes) return;
    if (event.type === 'signed-out') { clear(); return; }
    if (__DEV__) return;
    if (event.type === 'crash-permission' && matches(event.scope, latest.current)) {
      if (!event.enabled) { clear(); return; }
      approved.current = event.scope;
      try { NativeCrashes.configure(event.scope); } catch { recordFailure('crash_reporting_failed'); return; }
      const scope = event.scope;
      void NativeCrashes.pending(scope).then((reports) => {
        if (approved.current !== scope || !matches(scope, latest.current)) return;
        // Same five-report pass as the desktop regional uploader.
        for (const encoded of reports.slice(0, 5)) {
          const parsed = MobileCrashReportSchema.safeParse(JSON.parse(encoded) as unknown);
          if (!parsed.success) { recordFailure('crash_reporting_failed'); continue; }
          const report = parsed.data;
          if (!matches(report.scope, latest.current) || report.deleteAfter <= Date.now() || pending.current.has(report.metadata.uploadId)) continue;
          pending.current.add(report.metadata.uploadId);
          send({ type: 'crash-upload', report });
        }
      }).catch(() => recordFailure('crash_reporting_failed'));
    }
    if (event.type === 'crash-uploaded' && approved.current && matches(event.scope, latest.current)
      && pending.current.delete(event.uploadId)) {
      if (event.ok) { try { NativeCrashes.acknowledge(event.uploadId); } catch { recordFailure('crash_reporting_failed'); } }
      else recordFailure('crash_reporting_failed');
    }
  }, [send, clear]);
}
