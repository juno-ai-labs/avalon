/**
 * The desktop client's logger, shared by the main process and the renderer.
 *
 * Its sink is a terminal or a DevTools console read by a person, not Workers
 * Logs, so entries stay human-readable lines rather than indexed objects: the
 * scope tag every call already carried, the message, then whatever detail the
 * caller had. Routing them through here is what lets `no-console` hold, so a
 * diagnostic cannot reach a user's log without a level and a scope.
 */
export type LogScope = 'avalon' | 'meeting';

function emit(
  level: 'warn' | 'error',
  scope: LogScope,
  message: string,
  detail: readonly unknown[],
): void {
  /* eslint-disable no-console */
  const line = `[${scope}] ${message}`;
  if (level === 'error') console.error(line, ...detail);
  else console.warn(line, ...detail);
  /* eslint-enable no-console */
}

export function logWarn(scope: LogScope, message: string, ...detail: readonly unknown[]): void {
  emit('warn', scope, message, detail);
}

export function logError(scope: LogScope, message: string, ...detail: readonly unknown[]): void {
  emit('error', scope, message, detail);
}
