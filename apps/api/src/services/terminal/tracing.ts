import { AsyncLocalStorage } from "node:async_hooks";

export type TerminalProviderRequestOperation =
  | "sandbox.get"
  | "sandbox.refresh"
  | "sandbox.create"
  | "sandbox.start"
  | "sandbox.stop"
  | "sandbox.archive"
  | "sandbox.delete"
  | "sandbox.update_network"
  | "sandbox.update_secrets"
  | "file.download"
  | "file.upload"
  | "process.execute_utility"
  | "process.session_get"
  | "process.session_create"
  | "process.session_submit"
  | "process.session_poll"
  | "process.session_logs"
  | "process.session_delete"
  | "secret.list"
  | "secret.create"
  | "secret.update"
  | "secret.delete";

export type TerminalUtilityOperation =
  | "path.resolve"
  | "file.inspect"
  | "file.read_page"
  | "file.replace"
  | "file.apply_patch"
  | "file.temp_cleanup"
  | "resource.publish.inspect_before"
  | "resource.publish.inspect_after"
  | "resource.import.inspect"
  | "resource.import.finalize"
  | "repository.bootstrap"
  | "repository.publish.status"
  | "repository.publish.branch"
  | "repository.publish.head"
  | "repository.publish.ancestry"
  | "repository.publish.paths"
  | "repository.publish.push"
  | "lifecycle.final_diff"
  | "lifecycle.backup"
  | "lifecycle.backup_cleanup";

export interface TerminalProviderRequestMeasurement {
  operation: TerminalProviderRequestOperation;
  detail: TerminalUtilityOperation | null;
  outcome: "completed" | "failed";
  durationMs: number;
  requestCount: number;
  pollCount: number;
  bytes: number;
}

export interface TerminalToolTrace {
  toolName: string;
  toolCallId: string;
  toolInvocationId: string | null;
  providerDurationMs: number;
  providerRequestCount: number;
  providerPollCount: number;
  providerBytes: number;
  providerOperationCount: number;
  acquisitionDurationMs: number;
  acquisitionCacheHit: boolean | null;
}

const terminalToolTraceStorage = new AsyncLocalStorage<TerminalToolTrace>();

export function createTerminalToolTrace(input: {
  toolName: string;
  toolCallId: string;
  toolInvocationId: string | null;
}): TerminalToolTrace {
  return {
    ...input,
    providerDurationMs: 0,
    providerRequestCount: 0,
    providerPollCount: 0,
    providerBytes: 0,
    providerOperationCount: 0,
    acquisitionDurationMs: 0,
    acquisitionCacheHit: null,
  };
}

export function currentTerminalToolTrace(): TerminalToolTrace | undefined {
  return terminalToolTraceStorage.getStore();
}

export function withTerminalToolTrace<T>(trace: TerminalToolTrace, callback: () => Promise<T>): Promise<T> {
  return terminalToolTraceStorage.run(trace, callback);
}

export function recordTerminalProviderRequest(measurement: TerminalProviderRequestMeasurement): void {
  const trace = terminalToolTraceStorage.getStore();
  if (!trace) return;
  trace.providerDurationMs += measurement.durationMs;
  trace.providerRequestCount += measurement.requestCount;
  trace.providerPollCount += measurement.pollCount;
  trace.providerBytes += measurement.bytes;
  trace.providerOperationCount += 1;
}

export function recordTerminalAcquisition(input: { durationMs: number; cacheHit: boolean }): void {
  const trace = terminalToolTraceStorage.getStore();
  if (!trace) return;
  trace.acquisitionDurationMs += input.durationMs;
  trace.acquisitionCacheHit = input.cacheHit;
}
