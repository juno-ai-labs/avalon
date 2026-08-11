/**
 * The retention Worker's structured logger, deliberately a copy of
 * `apps/api/src/observability/logger.ts` rather than a shared import: this
 * Worker deploys on its own and depends on no workspace package.
 *
 * Workers Logs indexes the properties of a logged object as queryable fields
 * and renders `message` as the row summary in the log list. An entry has to
 * carry both — serializing it collapses the fields into one opaque string, and
 * omitting `message` lists the row blank.
 *
 * The bounds below are copied along with the shape. This Worker logs no
 * credentials, but it does log a whole `RetentionReport`, whose
 * `candidateKeys`, `archiveVersions`, and `retainedVersions` are unbounded
 * arrays of release keys — exactly what pushes an entry into the size at which
 * Workers Logs truncates it and sets `$workers.truncated`.
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

// `message` is the one reserved key: it becomes the row summary rather than an
// ordinary field, so it is typed as the string it has to be. The runtime falls
// back to the event name, which cannot carry a structured value.
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
