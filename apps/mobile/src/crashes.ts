import { randomUUID } from 'expo-crypto';
import { CrashReporting } from './crash-reporting';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';
import { MobileCrashScopeSchema } from '@rally/contracts/crash-reports';
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

export function useCrashReporting(directory: MobileSnapshot | null, send: (command: MobileCommand) => void) {
  const latest = useRef(directory); latest.current = directory;
  const reporting = useMemo(() => NativeCrashes
    ? new CrashReporting(NativeCrashes, send, () => recordFailure('crash_reporting_failed')) : null, [send]);
  useEffect(() => {
    const verify = () => {
      if (__DEV__ || !reporting) return;
      const current = latest.current;
      const scope = MobileCrashScopeSchema.safeParse({ userId: current?.userId, workspaceId: current?.workspaceId, route: current?.workspacePath.split('/')[3] });
      if (scope.success) reporting.verify(scope.data, randomUUID());
      else reporting.dispose();
    };
    verify();
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') verify(); });
    return () => { listener.remove(); reporting?.dispose(); };
  }, [directory?.userId, directory?.workspaceId, directory?.workspacePath, reporting]);
  return useCallback((event: MobileEvent) => { void reporting?.receive(event); }, [reporting]);
}
