/**
 * The retention Worker's structured logger, deliberately a copy of the shape
 * `apps/api/src/observability/logger.ts` emits rather than a shared import:
 * this Worker deploys on its own and depends on no workspace package.
 *
 * Workers Logs indexes the properties of a logged object as queryable fields
 * and renders `message` as the row summary in the log list. An entry has to
 * carry both — serializing it collapses the fields into one opaque string, and
 * omitting `message` lists the row blank.
 */
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
    ...rest,
  };
  /* eslint-disable no-console */
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.info(entry);
  /* eslint-enable no-console */
}
