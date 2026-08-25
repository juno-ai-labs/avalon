/**
 * The desktop client's logger, shared by the main process and the renderer.
 *
 * Its sink is a terminal or a DevTools console read by a person, not Workers
 * Logs, so entries stay human-readable lines rather than indexed objects: the
 * scope tag every call already carried, the message, then whatever detail the
 * caller had. Routing them through here is what lets `no-console` hold, so a
 * diagnostic cannot reach a user's log without a level and a scope.
 */
export type LogScope = 'rally' | 'meeting' | 'perf';

function emit(
  level: 'debug' | 'warn' | 'error',
  scope: LogScope,
  message: string,
  detail: readonly unknown[],
): void {
  /* eslint-disable no-console */
  const line = `[${scope}] ${message}`;
  if (level === 'error') console.error(line, ...detail);
  else if (level === 'warn') console.warn(line, ...detail);
  else console.debug(line, ...detail);
  /* eslint-enable no-console */
}

export function logWarn(scope: LogScope, message: string, ...detail: readonly unknown[]): void {
  emit('warn', scope, message, detail);
}

export function logError(scope: LogScope, message: string, ...detail: readonly unknown[]): void {
  emit('error', scope, message, detail);
}

/**
 * The trace level. `console.debug` is filtered out of DevTools and of a
 * terminal by default, so these lines cost a reader nothing until they open
 * the Verbose level to look for them — which is what lets the performance
 * traces in `docs/performance-tracing.md` stay on in every build rather than
 * behind a preference nobody has enabled when the slow open happens.
 */
export function logDebug(scope: LogScope, message: string, ...detail: readonly unknown[]): void {
  emit('debug', scope, message, detail);
}
