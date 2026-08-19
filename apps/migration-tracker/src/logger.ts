/**
 * The tracker's structured logger.
 *
 * Deliberately a copy of `apps/release-retention/src/logger.ts`, for the reason
 * that file gives: Workers Logs indexes a logged object's properties as
 * queryable fields and renders `message` as the row summary, so an entry has to
 * carry both, and this Worker must not import from the Worker it observes.
 */
const REDACTED = "[REDACTED]";
const sensitiveKey = /token|secret|authorization|cookie|credential/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? REDACTED : redact(item, depth + 1),
      ]),
    );
  }
  if (typeof value === "string" && value.length > 2_000) return `${value.slice(0, 2_000)}…`;
  return value;
}

export type LogFields = Record<string, unknown> & { message?: string };

export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: LogFields = {},
): void {
  const { message: provided, ...rest } = fields;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    message: typeof provided === "string" && provided.length > 0 ? provided : event,
    ...redact(rest) as Record<string, unknown>,
  };
  /* eslint-disable no-console */
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.info(entry);
  /* eslint-enable no-console */
}
